// One replay session: a single trading day, a single instrument, a $100k paper account.
//
// NO-LOOKAHEAD CONTRACT: the full day's bars live in a private field (#legBars) and
// are only ever read through #barAt(i) with i <= cursor. Everything the UI, the
// indicators and the order book see comes from revealed*() / quote(), which are
// bounded by the cursor. Working orders are only tested against bars revealed after
// they were placed.
import { PRODUCTS, SPREADS, ACCOUNT, SESSION, PAUSE_TYPES } from './config.js';
import { getInstrument, instrumentQuote, productQuote, slippage, roundTo } from './instruments.js';
import { marketFillPrice, barFillPrice } from './orders.js';
import { Account } from './account.js';

export function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function prevCalendarDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Keep the bars inside the pit session window. */
export function sessionBars(bars, open = SESSION.open, close = SESSION.close) {
  return bars.filter((b) => b.time >= open && b.time < close);
}

export class Session {
  #legBars;   // { product: bar[] } full day, aligned by time. PRIVATE: never exposed.
  #times;

  constructor({ day, instrumentId, dayBars, headlines = [], prevDay = null,
    products = PRODUCTS, spreads = SPREADS, account = {} }) {
    this.day = day;
    this.products = products;
    this.inst = getInstrument(instrumentId, products, spreads);
    const legs = this.inst.legs.map((l) => l.product);
    for (const p of legs) if (!dayBars[p]) throw new Error(`No bars for ${p} on ${day}`);
    // align legs on common bar times (all legs must have printed that bar)
    const sets = legs.map((p) => new Map(sessionBars(dayBars[p]).map((b) => [b.time, b])));
    this.#times = [...sets[0].keys()].filter((t) => sets.every((s) => s.has(t))).sort();
    if (this.#times.length < 2) throw new Error(`Not enough bars for ${instrumentId} on ${day}`);
    this.#legBars = Object.fromEntries(legs.map((p, i) => [p, this.#times.map((t) => sets[i].get(t))]));
    this.barCount = this.#times.length;

    this.account = new Account(this.inst, { products, ...account });
    this.slip = slippage(this.inst, products, account.slippageTicks ?? ACCOUNT.slippageTicks);
    this.orders = [];
    this.tape = [];
    this.equityCurve = [];
    this.nextOrderId = 1;
    this.cursor = 0;            // index of the last revealed (completed) bar
    this.finished = false;
    this.pauseEvent = null;

    const prevKey = `${prevDay ?? prevCalendarDay(day)} ${SESSION.close}`;
    this.headlines = headlines
      .filter((h) => !h.products || h.products.length === 0 || h.products.some((p) => legs.includes(p)))
      .map((h) => ({ ...h, key: `${h.date} ${h.time}` }))
      .filter((h) => h.key > prevKey && h.date <= day)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    this.headlineIdx = 0;

    this.firstQuote = this.quote();
    this.#printHeadlines(true);
    this.#recordEquity();
  }

  // ---- revealed data (the only market data accessors) ----
  #barAt(product, i) {
    if (i > this.cursor) throw new Error('lookahead blocked');
    return this.#legBars[product][i];
  }

  /** Clock = close time of the last revealed bar (CT, HH:MM). */
  clock() { return addMinutes(this.#times[this.cursor], SESSION.barMinutes); }
  clockKey() { return `${this.day} ${this.clock()}`; }
  get isLastBar() { return this.cursor >= this.barCount - 1; }
  progress() { return this.cursor / (this.barCount - 1); }

  revealedLeg(product) {
    const out = [];
    for (let i = 0; i <= this.cursor; i++) out.push(this.#barAt(product, i));
    return out;
  }

  #instBarAt(i) {
    if (this.inst.kind === 'outright') return this.#barAt(this.inst.id, i);
    // Synthetic spread bar. Leg highs/lows can happen at different moments, so the
    // spread's true intrabar range is unknowable from OHLC; we use open/close only.
    let o = 0, c = 0, v = Infinity;
    for (const leg of this.inst.legs) {
      const b = this.#barAt(leg.product, i);
      o += leg.ratio * b.o; c += leg.ratio * b.c; v = Math.min(v, b.v || 0);
    }
    const t = this.inst.tick;
    o = roundTo(o, t); c = roundTo(c, t);
    return { time: this.#times[i], o, h: Math.max(o, c), l: Math.min(o, c), c, v };
  }

  revealedBars() {
    const out = [];
    for (let i = 0; i <= this.cursor; i++) out.push(this.#instBarAt(i));
    return out;
  }

  lastByProduct() {
    const out = {};
    for (const leg of this.inst.legs) out[leg.product] = this.#barAt(leg.product, this.cursor).c;
    return out;
  }

  quote() { return instrumentQuote(this.inst, this.lastByProduct(), this.products); }
  legQuotes() {
    const last = this.lastByProduct();
    return this.inst.legs.map((l) => ({ product: l.product, ratio: l.ratio, ...productQuote(l.product, last[l.product], this.products) }));
  }

  mark() { return this.quote().last; }
  equity() { return this.account.equity(this.mark()); }
  marginUsed() { return this.account.marginUsed(this.lastByProduct()); }
  workingOrders() { return this.orders.filter((o) => o.status === 'WORKING'); }

  // ---- orders ----
  /**
   * spec: { side: 'BUY'|'SELL', type: 'MKT'|'LMT'|'STP', qty, price?, bracket?: { stop?, target? } }
   * Returns { ok, order?, error? }.
   */
  submit(spec) {
    if (this.finished) return { ok: false, error: 'Session is over' };
    const side = spec.side;
    const type = spec.type || 'MKT';
    const qty = Number(spec.qty);
    if (side !== 'BUY' && side !== 'SELL') return { ok: false, error: 'Side must be BUY or SELL' };
    if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: 'Size must be a whole number of contracts' };
    let price = null;
    if (type === 'LMT' || type === 'STP') {
      price = Number(spec.price);
      if (!Number.isFinite(price)) return { ok: false, error: `${type} order needs a price` };
      price = roundTo(price, this.inst.tick);
    } else if (type !== 'MKT') return { ok: false, error: `Unknown order type ${type}` };

    const bracket = this.#validateBracket(side, type, price, spec.bracket);
    if (bracket.error) return { ok: false, error: bracket.error };

    const m = this.account.checkMargin(side, qty, this.mark(), this.lastByProduct());
    if (!m.ok) {
      return { ok: false, error: `Blocked: margin ${fmt$(m.required)} would exceed available equity ${fmt$(m.available)}` };
    }

    const order = { id: this.nextOrderId++, side, type, qty, price, status: 'WORKING',
      placedAt: this.cursor, placedClock: this.clock(), bracket: bracket.value, parentId: null, oco: null, tag: spec.tag || '' };
    this.orders.push(order);

    if (type === 'MKT') {
      const fillPrice = marketFillPrice(side, this.quote(), this.slip, this.inst.tick);
      this.#execute(order, fillPrice, 'market');
    } else {
      this.#log('order', `${side} ${qty} ${this.inst.id} ${type} @ ${this.fmtPx(price)} working`);
    }
    return { ok: true, order };
  }

  #validateBracket(side, type, price, b) {
    if (!b || (b.stop == null && b.target == null) || (b.stop === '' && b.target === '')) return { value: null };
    const ref = type === 'LMT' || type === 'STP' ? price : this.mark();
    const stop = b.stop === '' || b.stop == null ? null : roundTo(Number(b.stop), this.inst.tick);
    const target = b.target === '' || b.target == null ? null : roundTo(Number(b.target), this.inst.tick);
    if ((stop != null && !Number.isFinite(stop)) || (target != null && !Number.isFinite(target))) return { error: 'Bracket prices must be numbers' };
    const long = side === 'BUY';
    if (stop != null && (long ? stop >= ref : stop <= ref)) return { error: `Stop loss must be ${long ? 'below' : 'above'} the entry (${this.fmtPx(ref)})` };
    if (target != null && (long ? target <= ref : target >= ref)) return { error: `Take profit must be ${long ? 'above' : 'below'} the entry (${this.fmtPx(ref)})` };
    return { value: { stop, target } };
  }

  cancel(id) {
    const o = this.orders.find((x) => x.id === id);
    if (!o || o.status !== 'WORKING') return false;
    o.status = 'CANCELLED';
    this.#log('order', `Cancelled #${o.id} ${o.side} ${o.qty} ${o.type}${o.price != null ? ' @ ' + this.fmtPx(o.price) : ''}`);
    return true;
  }

  /** Cancel every working order and close the position at market. */
  flatten(reason = 'flatten') {
    for (const o of this.workingOrders()) { o.status = 'CANCELLED'; }
    const pos = this.account.position;
    if (pos === 0) return { ok: true };
    const side = pos > 0 ? 'SELL' : 'BUY';
    const order = { id: this.nextOrderId++, side, type: 'MKT', qty: Math.abs(pos), price: null, status: 'WORKING',
      placedAt: this.cursor, placedClock: this.clock(), bracket: null, parentId: null, oco: null, tag: reason };
    this.orders.push(order);
    this.#execute(order, marketFillPrice(side, this.quote(), this.slip, this.inst.tick), reason);
    return { ok: true, order };
  }

  #execute(order, price, reason) {
    order.status = 'FILLED';
    order.fillPrice = price;
    order.fillClock = this.clock();
    const closed = this.account.fill({ side: order.side, qty: order.qty, price, time: this.clock(), reason });
    this.#log('fill', `FILL ${order.side} ${order.qty} ${this.inst.id} @ ${this.fmtPx(price)} (${reason})`, { order, closed });
    if (order.bracket) this.#attachBracket(order);
    if (this.account.position === 0) {
      for (const o of this.workingOrders()) if (o.parentId != null) o.status = 'CANCELLED';
    }
  }

  #attachBracket(parent) {
    const exitSide = parent.side === 'BUY' ? 'SELL' : 'BUY';
    const oco = `oco${parent.id}`;
    const mk = (type, price, tag) => {
      const o = { id: this.nextOrderId++, side: exitSide, type, qty: parent.qty, price, status: 'WORKING',
        placedAt: this.cursor, placedClock: this.clock(), bracket: null, parentId: parent.id, oco, tag };
      this.orders.push(o);
      this.#log('order', `Bracket ${tag} ${exitSide} ${o.qty} ${type} @ ${this.fmtPx(price)} working`);
    };
    if (parent.bracket.stop != null) mk('STP', parent.bracket.stop, 'stop loss');
    if (parent.bracket.target != null) mk('LMT', parent.bracket.target, 'take profit');
  }

  #processOrders(barIndex) {
    const bar = this.#instBarAt(barIndex);
    const eligible = this.workingOrders().filter((o) => o.placedAt < barIndex);
    // entries first, then exits; within exits stops before limits (conservative when
    // a single bar spans both the stop and the target)
    eligible.sort((a, b) => (a.parentId != null) - (b.parentId != null)
      || (a.type === 'STP' ? 0 : 1) - (b.type === 'STP' ? 0 : 1) || a.id - b.id);
    for (const o of eligible) {
      if (o.status !== 'WORKING') continue;
      if (o.parentId != null) {
        const pos = this.account.position;
        const closingSide = pos > 0 ? 'SELL' : 'BUY';
        if (pos === 0 || o.side !== closingSide) { o.status = 'CANCELLED'; continue; }
        o.qty = Math.min(o.qty, Math.abs(pos)); // exits are reduce-only
      }
      const px = barFillPrice(o, bar, this.slip, this.inst.tick);
      if (px == null) continue;
      if (o.parentId == null) {
        const m = this.account.checkMargin(o.side, o.qty, this.mark(), this.lastByProduct());
        if (!m.ok) {
          o.status = 'REJECTED';
          this.#log('system', `Rejected #${o.id}: margin ${fmt$(m.required)} exceeds equity ${fmt$(m.available)}`);
          continue;
        }
      }
      this.#execute(o, px, o.tag || (o.type === 'LMT' ? 'limit' : 'stop'));
      if (o.oco) for (const s of this.workingOrders()) if (s.oco === o.oco) s.status = 'CANCELLED';
    }
  }

  // ---- replay ----
  /** Reveal the next bar. Returns { pauseEvent } when an EIA/API print time is reached. */
  step() {
    if (this.finished) return { done: true };
    if (this.isLastBar) { this.finish(); return { done: true }; }
    this.pauseEvent = null;
    this.cursor += 1;
    this.#processOrders(this.cursor);
    this.#printHeadlines(false);
    this.#recordEquity();
    if (this.isLastBar) this.#log('system', `${SESSION.close} CT: session close. Flatten or press step to finish.`);
    return { done: false, pauseEvent: this.pauseEvent };
  }

  /** End the session: cancel orders, flatten at the final bar, freeze the account. */
  finish() {
    if (this.finished) return;
    if (this.account.position !== 0 || this.workingOrders().length) this.flatten('session close');
    this.#recordEquity();
    this.finalQuote = this.quote();
    this.finished = true;
    this.#log('system', 'Session finished.');
  }

  #printHeadlines(initial) {
    const nowKey = this.clockKey();
    const openKey = `${this.day} ${SESSION.open}`;
    while (this.headlineIdx < this.headlines.length && this.headlines[this.headlineIdx].key <= nowKey) {
      const h = this.headlines[this.headlineIdx++];
      const prior = h.key < openKey;
      this.#log('headline', h.headline, { item: h, prior });
      if (!initial && !prior && h.date === this.day && (h.pause ?? PAUSE_TYPES.includes(h.type))) this.pauseEvent = h;
    }
  }

  #recordEquity() { this.equityCurve.push({ clock: this.clock(), equity: this.equity() }); }

  #log(kind, text, extra = {}) { this.tape.push({ clock: this.clock(), kind, text, ...extra }); }

  fmtPx(p) { return p == null ? '' : p.toFixed(this.inst.decimals); }
}

function fmt$(n) { return `$${Math.round(n).toLocaleString('en-US')}`; }

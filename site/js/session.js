// One replay session: a single trading day, a single instrument, a $100k paper account.
//
// NO-LOOKAHEAD CONTRACT: the full day's bars live in a private field (#legBars) and
// are only ever read through #barAt(i) with i <= cursor. Everything the UI, the
// indicators and the order book see comes from revealed*() / quote(), which are
// bounded by the cursor. Working orders are only tested against bars revealed after
// they were placed.
import { PRODUCTS, SPREADS, ACCOUNT, SESSION, PAUSE_TYPES, BAIT_WINDOW_MINUTES, COACH } from './config.js';
import { validateTicket, CARD_TEXT, CARD_ANSWERS, NO_SIGNAL, PRINT_SIGNAL, PASS_REASONS } from './coach.js';
import { getInstrument, instrumentQuote, productQuote, slippage, roundTo } from './instruments.js';
import { marketFillPrice, barFillPrice } from './orders.js';
import { Account } from './account.js';

export function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
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
    products = PRODUCTS, spreads = SPREADS, account = {}, coach = false, now = null }) {
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
    // ---- coach layer (Training path). With coach=false none of the gates apply.
    this.coach = Boolean(coach);
    this.now = now || (() => Date.now());
    this.briefingViewed = !this.coach;
    this.entries = [];          // ticketed fills that opened or added exposure
    this.ticketsLogged = 0;     // complete tickets accepted (filled or still working)
    this.passes = [];           // headlines the trader explicitly passed on
    this.coachLog = [];         // every coach card shown, with the answer given
    this.stopOuts = [];
    this.printsHeld = [];       // scheduled prints a position was carried through unplanned
    this.lock = null;           // { untilMs, signal, clock } after a stop-out
    this.pendingCards = [];
    this.followUps = [];
    this.firstHeadlineDone = false;
    this.baitEvents = [];       // opening fills taken right after a red herring (revealed post-session only)
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

    let ticket = null;
    let bracketSpec = spec.bracket;
    if (this.coach) {
      if (!this.briefingViewed) return { ok: false, error: 'Read the morning briefing first. Trading unlocks when you reach the end.' };
      if (this.isEntry(side, qty)) {
        const v = validateTicket(spec.ticket, { side, ref: price ?? this.mark(), tick: this.inst.tick });
        if (!v.ok) return { ok: false, needsTicket: true, ticketErrors: v.errors, error: `Ticket incomplete: ${v.errors.join('; ')}.` };
        ticket = v.ticket;
        const lock = this.lockout();
        if (lock && (lock.signal == null || ticket.signal === lock.signal)) {
          return { ok: false, locked: true, error: `Locked out ${fmtMs(lock.remainingMs)} after the ${lock.clock} stop-out. Same idea again needs a NEW signal: a ticket with a different signal overrides.` };
        }
        if (ticket.attachStop) bracketSpec = { ...(bracketSpec || {}), stop: ticket.wrong };
      }
    }

    const bracket = this.#validateBracket(side, type, price, bracketSpec);
    if (bracket.error) return { ok: false, error: bracket.error };

    const m = this.account.checkMargin(side, qty, this.mark(), this.lastByProduct());
    if (!m.ok) {
      return { ok: false, error: `Blocked: margin ${fmt$(m.required)} would exceed available equity ${fmt$(m.available)}` };
    }

    const order = { id: this.nextOrderId++, side, type, qty, price, status: 'WORKING',
      placedAt: this.cursor, placedClock: this.clock(), bracket: bracket.value, parentId: null, oco: null, tag: spec.tag || '', ticket };
    this.orders.push(order);
    if (ticket) this.ticketsLogged += 1;

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
    const bait = order.parentId == null ? this.#baitFor(order) : null;
    const rec = order.ticket ? this.#entryRecord(order, price) : null;
    const closed = this.account.fill({ side: order.side, qty: order.qty, price, time: this.clock(), reason,
      lotMeta: bait || rec ? { baitedBy: bait?.item ?? null, ticket: order.ticket ?? null, entry: rec } : null });
    for (const t of closed) {   // the exit price counts toward the closed lot's best/worst excursion
      const e = t.meta?.entry;
      if (e) { const long = t.side === 'LONG'; e.best = long ? Math.max(e.best, price) : Math.min(e.best, price); e.worst = long ? Math.min(e.worst, price) : Math.max(e.worst, price); }
    }
    if (rec && this.account.lastOpenedQty > 0) { rec.qty = this.account.lastOpenedQty; this.entries.push(rec); }
    if (order.type === 'STP' && closed.length && this.account.lastOpenedQty === 0) this.#stopOut(order, price, closed);
    if (bait && this.account.lastOpenedQty > 0) {
      this.baitEvents.push({ clock: this.clock(), side: order.side, qty: this.account.lastOpenedQty, price,
        herringClock: bait.clock, headline: bait.item.headline });
    }
    this.#log('fill', `FILL ${order.side} ${order.qty} ${this.inst.id} @ ${this.fmtPx(price)} (${reason})`, { order, closed });
    if (order.bracket) this.#attachBracket(order);
    if (this.account.position === 0) {
      for (const o of this.workingOrders()) if (o.parentId != null) o.status = 'CANCELLED';
    }
  }

  /**
   * Red herring that this order chased, if any: a noise headline that printed at most
   * BAIT_WINDOW_MINUTES before this fill, implying this order's direction (BUY = up),
   * where the order was placed at or after the print (a resting order placed earlier
   * was not a reaction to it). Returns the most recent match.
   */
  #baitFor(order) {
    const dir = order.side === 'BUY' ? 'up' : 'down';
    const now = minutesOf(this.clock());
    let hit = null;
    for (const t of this.tape) {
      if (t.kind !== 'headline' || t.item.class !== 'noise' || t.item.implies !== dir) continue;
      const printed = minutesOf(t.clock);
      if (now - printed < 0 || now - printed > BAIT_WINDOW_MINUTES) continue;
      if (minutesOf(order.placedClock) < printed) continue;
      hit = t;
    }
    return hit;
  }

  /** True when this order would open or add exposure (so it needs a ticket in coach mode). */
  isEntry(side, qty) {
    const pos = this.account.position;
    const signed = side === 'BUY' ? qty : -qty;
    return pos === 0 || Math.sign(signed) === Math.sign(pos) || Math.abs(signed) > Math.abs(pos);
  }

  /** Active stop-out lockout, or null. Real time, from the injected clock. */
  lockout() {
    if (!this.lock) return null;
    const remainingMs = this.lock.untilMs - this.now();
    return remainingMs > 0 ? { ...this.lock, remainingMs } : null;
  }

  #entryRecord(order, price) {
    const t = order.ticket;
    const now = minutesOf(this.clock());
    const last = this.stopOuts.at(-1);
    const sinceStop = last ? now - minutesOf(last.clock) : Infinity;
    const onHeadlineBar = this.tape.some((x) => x.kind === 'headline' && !x.prior && x.clock === order.placedClock);
    return {
      orderId: order.id, ticket: t, side: order.side, type: order.type, placedClock: order.placedClock, fillClock: this.clock(),
      price, qty: order.qty, stop: order.bracket?.stop ?? null, R: Math.max(Math.abs(price - t.wrong), this.inst.tick),
      best: price, worst: price, warned1R: false,
      flags: {
        noSignal: t.signal === NO_SIGNAL,
        noStop: order.bracket?.stop == null,
        revenge: sinceStop >= 0 && sinceStop <= COACH.revengeMinutes,
        impulse: onHeadlineBar && !t.headlinePause,
        lockOverride: Boolean(this.lockout()),
      },
    };
  }

  #stopOut(order, price, closed) {
    const signal = closed[0].meta?.ticket?.signal ?? null;
    this.stopOuts.push({ clock: this.clock(), price, signal });
    if (!this.coach) return;
    this.lock = { untilMs: this.now() + COACH.lockoutMs, signal, clock: this.clock() };
    this.#card('stopOut', `${this.clock()}: stopped out at ${this.fmtPx(price)}. Re-entry locked 3 minutes.`);
  }

  #card(key, context, extra = {}) {
    const card = { id: this.coachLog.length + 1, key, clock: this.clock(), text: `${context} ${CARD_TEXT[key]}`.trim(),
      answers: CARD_ANSWERS[key] || [], answer: null, dismissed: false, ...extra };
    this.coachLog.push(card);
    this.pendingCards.push(card);
    return card;
  }

  /** Log the trader's one-tap answer (or a plain dismissal) for a coach card. */
  answerCard(id, answer = null) {
    const c = this.coachLog.find((x) => x.id === id);
    if (!c) return false;
    c.answer = answer; c.dismissed = true; c.answeredClock = this.clock();
    return true;
  }

  /** "Passed on this headline": tapeIndex is the index in this.tape. Reason is optional. */
  pass(tapeIndex, reason = '') {
    const t = this.tape[tapeIndex];
    if (this.finished || !t || t.kind !== 'headline') return false;
    if (!PASS_REASONS.includes(reason)) reason = '';
    const existing = this.passes.find((p) => p.tapeIndex === tapeIndex);
    if (existing) existing.reason = reason || existing.reason;
    else this.passes.push({ tapeIndex, clock: this.clock(), printedClock: t.clock, headline: t.item.headline, reason });
    t.passed = { reason: reason || existing?.reason || '' };
    return true;
  }

  #coachStep(printed) {
    const bar = this.#instBarAt(this.cursor);
    const mark = this.mark();
    const lots = this.account.lots.filter((l) => l.meta?.entry);
    for (const l of lots) {
      const e = l.meta.entry, long = l.qty > 0;
      e.best = long ? Math.max(e.best, bar.h) : Math.min(e.best, bar.l);
      e.worst = long ? Math.min(e.worst, bar.l) : Math.max(e.worst, bar.h);
    }
    if (!this.coach) return;
    const clock = this.clock();
    const pos = this.account.position;
    const posText = pos === 0 ? 'flat' : `${pos > 0 ? 'Long' : 'Short'} ${Math.abs(pos)} from ${this.fmtPx(this.account.avgEntry)}`;
    if (printed.length && !this.firstHeadlineDone) {
      this.firstHeadlineDone = true;
      this.#card('firstHeadline', `${clock}: first headline of the day. You are ${posText}.`);
    }
    for (const t of printed.filter((x) => x.item.time_precision === 'exact')) {
      const h = t.item;
      this.#card('print', `${h.type} ${h.time} CT, last ${this.fmtPx(mark)}.`, { print: `${h.type} ${h.time}` });
      this.followUps.push({ cursor: this.cursor + COACH.printFollowBars, type: h.type, time: h.time, px: mark });
      if (pos !== 0 && lots.some((l) => l.meta.ticket && l.meta.ticket.signal !== PRINT_SIGNAL)) {
        this.printsHeld.push({ type: h.type, time: h.time, clock, position: posText.toLowerCase() });
      }
    }
    for (const f of this.followUps.filter((x) => x.cursor === this.cursor)) {
      this.#card('printFollow', `${f.type} ${f.time}: ${this.fmtPx(f.px)} at the print, ${this.fmtPx(mark)} now.`, { print: `${f.type} ${f.time}` });
    }
    for (const l of lots) {
      const e = l.meta.entry, long = l.qty > 0;
      const against = long ? e.price - mark : mark - e.price;
      if (!e.warned1R && against >= e.R - 1e-9) {
        e.warned1R = true;
        this.#card('oneR', `${long ? 'Long' : 'Short'} ${Math.abs(l.qty)} from ${this.fmtPx(e.price)} at ${e.fillClock}, now ${this.fmtPx(mark)}: 1R against.`);
      }
    }
    if (pos !== 0 && clock === COACH.reunderwriteAt) this.#card('reunderwrite', `${clock}. ${posText}, now ${this.fmtPx(mark)}.`);
    if (pos !== 0 && clock === COACH.lastHourAt) this.#card('lastHour', `${clock}. ${posText}, now ${this.fmtPx(mark)}.`);
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
    const printed = this.#printHeadlines(false);
    this.#coachStep(printed);
    this.#recordEquity();
    if (this.isLastBar) this.#log('system', `${SESSION.close} CT: session close. Flatten or press step to finish.`);
    return { done: false, pauseEvent: this.pauseEvent, cards: this.pendingCards.splice(0) };
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
    const printed = [];
    while (this.headlineIdx < this.headlines.length && this.headlines[this.headlineIdx].key <= nowKey) {
      const h = this.headlines[this.headlineIdx++];
      const prior = h.key < openKey;
      this.#log('headline', h.headline, { item: h, prior });
      if (!initial && !prior) printed.push(this.tape.at(-1));
      if (!initial && !prior && h.date === this.day && (h.pause ?? PAUSE_TYPES.includes(h.type))) this.pauseEvent = h;
    }
    return printed;
  }

  #recordEquity() { this.equityCurve.push({ clock: this.clock(), equity: this.equity() }); }

  #log(kind, text, extra = {}) { this.tape.push({ clock: this.clock(), kind, text, ...extra }); }

  fmtPx(p) { return p == null ? '' : p.toFixed(this.inst.decimals); }
}

function fmt$(n) { return `$${Math.round(n).toLocaleString('en-US')}`; }
function fmtMs(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

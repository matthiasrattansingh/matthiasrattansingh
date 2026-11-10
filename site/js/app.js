// REPLAY DESK UI wiring. All market data shown comes from Session's revealed accessors.
import { PRODUCTS, SPREADS, SPEEDS, ACCOUNT, SESSION, BAIT_WINDOW_MINUTES } from './config.js';
import { Session } from './session.js';
import { vwap, ema } from './indicators.js';
import { marginFor, feesFor } from './instruments.js';
import { drawChart, sessionSlots } from './chart.js';
import { reportCard, tradesToCsv, loadScores, saveScore, clearScores, aggregate } from './report.js';
import { mergeSignalStats } from './coach.js';
import { initCoachUi } from './coach-ui.js';
import { headlineHtml, esc } from './tape.js';

const $ = (id) => document.getElementById(id);
const state = { manifest: null, headlines: [], data: {}, session: null, playing: false, speed: 0, timer: null, hover: null, reported: false, lastCard: null,
  coach: {}, mode: 'train', scoreId: null, debrief: null, trained: false };
let coachUi = null;

const money = (n, sign = false) => {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}$${s}`;
};
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

async function loadJson(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function boot() {
  try {
    state.manifest = await loadJson('data/manifest.json');
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin', `<div class="banner"><div><strong>Could not load data.</strong> ${esc(e.message)}. Serve this folder over http (e.g. <code>python3 -m http.server</code>), file:// cannot fetch JSON.</div></div>`);
    return;
  }
  try { state.headlines = (await loadJson('data/headlines.json')).headlines || []; } catch (e) { console.warn('headlines.json', e); }
  try { state.coach = (await loadJson('data/coach.json')).days || {}; } catch (e) { console.warn('coach.json', e); }
  try { state.mode = localStorage.getItem('replaydesk.mode') === 'free' ? 'free' : 'train'; } catch { /* default */ }
  const syms = Object.keys(state.manifest.products);
  await Promise.all(syms.map(async (s) => { state.data[s] = await loadJson(`data/${state.manifest.products[s].file}`); }));

  const days = [...new Set(syms.flatMap((s) => state.manifest.products[s].days))].sort();
  $('daySel').innerHTML = days.map((d) => `<option value="${d}">${d} ${new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</option>`).join('');
  $('daySel').value = days.at(-1);
  const insts = syms.filter((s) => PRODUCTS[s]).map((s) => [s, `${s} · ${PRODUCTS[s].name}`]);
  for (const [id, sp] of Object.entries(SPREADS)) if (sp.legs.every((l) => syms.includes(l.product))) insts.push([id, `${id} spread · ${sp.name}`]);
  $('instSel').innerHTML = insts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  if (state.manifest.failed && Object.keys(state.manifest.failed).length) {
    $('ticketMsg').textContent = `Missing data (download failed): ${Object.keys(state.manifest.failed).join(', ')}`;
  }

  $('speeds').innerHTML = SPEEDS.map((s, i) => `<button class="btn btn-sm" data-speed="${i}">${s.label}</button>`).join('');
  setSpeed(0);
  coachUi = initCoachUi({ state, $, money, cls, msg, play, stop, renderScores, submit: submitSpec, loadDay,
    priorClose, dayBars: (s) => dayBarsFor(s.inst.id, s.day), scheduled: scheduledFor });
  $('modeSel').value = state.mode;
  wire();
  if (state.mode === 'train') { const next = coachUi.renderPath(); if (next && days.includes(next)) $('daySel').value = next; }
  newSession();
  renderScores();
}

function availableDays(inst) {
  const legs = PRODUCTS[inst] ? [inst] : SPREADS[inst].legs.map((l) => l.product);
  return legs.map((p) => state.manifest.products[p].days).reduce((a, b) => a.filter((d) => b.includes(d)));
}

const legsOf = (inst) => (PRODUCTS[inst] ? [inst] : SPREADS[inst].legs.map((l) => l.product));
const dayBarsFor = (inst, day) => Object.fromEntries(legsOf(inst).map((p) => [p, state.data[p].days[day]]));

/** Last trade of the previous session in the data for this instrument (past data only). */
function priorClose(s) {
  const days = availableDays(s.inst.id);
  const prev = days[days.indexOf(s.day) - 1];
  if (!prev) return null;
  const v = s.inst.legs.reduce((sum, l) => sum + l.ratio * state.data[l.product].days[prev].at(-1).c, 0);
  return { day: prev, value: v.toFixed(s.inst.decimals) };
}

/** Scheduled (exact-time) prints for this session: public calendar items. */
function scheduledFor(s) {
  return s.headlines.filter((h) => h.date === s.day && h.time_precision === 'exact').map((h) => ({ time: h.time, type: h.type }));
}

function loadDay(day) {
  const s = state.session;
  if (s && !s.finished && (s.account.position || s.account.fills.length) && !confirm('Abandon the current session? It will not be scored.')) return;
  $('daySel').value = day;
  newSession();
}

function newSession() {
  stop();
  coachUi.reset();
  const day = $('daySel').value, inst = $('instSel').value;
  const days = availableDays(inst);
  if (!days.includes(day)) { msg(`${inst} has no data for ${day}`, true); return; }
  const legs = PRODUCTS[inst] ? [inst] : SPREADS[inst].legs.map((l) => l.product);
  const dayBars = Object.fromEntries(legs.map((p) => [p, state.data[p].days[day]]));
  const prevDay = days[days.indexOf(day) - 1] ?? null;
  state.session = new Session({ day, instrumentId: inst, dayBars, headlines: state.headlines, prevDay, coach: state.mode === 'train' });
  state.reported = false; state.lastCard = null; state.scoreId = null; state.debrief = null; state.trained = false;
  $('banner').hidden = true;
  $('clockDay').textContent = day;
  $('instName').textContent = `${state.session.inst.id} · ${state.session.inst.name}`;
  const step = state.session.inst.tick;
  $('ordPrice').step = String(step);
  buildProgressTicks();
  prefillPrices(true);
  msg('Session loaded. Flat, $' + ACCOUNT.startingCash.toLocaleString() + ' paper account.' + (state.mode === 'free' ? ' Free play: untrained.' : ''));
  $('pathCard').classList.toggle('free', state.mode === 'free');
  coachUi.renderPath();
  render();
  if (state.session.coach) coachUi.showBriefing();
}

function buildProgressTicks() {
  const slots = sessionSlots();
  const s = state.session;
  let html = '';
  slots.forEach((t, i) => { if (t.endsWith(':00')) html += `<span style="left:${(i / (slots.length - 1)) * 100}%">${t}</span>`; });
  // scheduled data releases are public calendar items, so they are marked ahead of time
  for (const h of s.headlines) {
    if (h.date === s.day && h.time >= SESSION.open && h.time < SESSION.close && h.time_precision === 'exact') {
      const i = slots.indexOf(h.time);
      if (i >= 0) html += `<span class="ev" title="${esc(h.type)} ${h.time} CT (scheduled)" style="left:${((i - 1) / (slots.length - 1)) * 100}%"></span>`;
    }
  }
  $('progressTicks').innerHTML = html;
}

// ---------------------------------------------------------------- replay control
function setSpeed(i) {
  state.speed = i;
  document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === i));
  const s = SPEEDS[i];
  $('speedInfo').textContent = `${s.label} = one 5-min bar every ${(s.msPerBar / 1000).toFixed(s.msPerBar < 1000 ? 3 : 2)} s (${Math.round(300000 / s.msPerBar)}× real time)`;
  if (state.playing) { clearTimeout(state.timer); schedule(); }
}

function play() {
  const s = state.session;
  if (!s || s.finished || coachUi.blocked()) return;
  $('banner').hidden = true;
  state.playing = true; schedule(); renderControls();
}
function stop() { state.playing = false; clearTimeout(state.timer); renderControls(); }
function toggle() { state.playing ? stop() : play(); }
function schedule() { state.timer = setTimeout(() => { advance(1); if (state.playing) schedule(); }, SPEEDS[state.speed].msPerBar); }

function advance(n) {
  const s = state.session;
  if (!s || s.finished || coachUi.blocked()) return;
  $('banner').hidden = true;
  for (let k = 0; k < n; k++) {
    const r = s.step();
    if (s.isLastBar) { s.finish(); }
    if (s.finished) { stop(); render(); showReport(); return; }
    if (s.coach) {
      if (r.cards && r.cards.length) { const was = state.playing; stop(); render(); coachUi.queueCards(r.cards, was); return; }
    } else if (r.pauseEvent) { stop(); showBanner(r.pauseEvent); break; }
  }
  render();
}

function showBanner(h) {
  $('bannerTitle').textContent = `${h.type} ${h.time} CT`;
  $('bannerText').textContent = `${h.headline}. Replay paused: decide, then resume.`;
  $('banner').hidden = false;
}

// ---------------------------------------------------------------- orders
function readTicket(side, forceMarket = false) {
  const type = forceMarket ? 'MKT' : $('ordType').value;
  const spec = { side, type, qty: Number($('qty').value) };
  if (type !== 'MKT') spec.price = $('ordPrice').value;
  if (!forceMarket && $('bracketChk').checked) spec.bracket = bracketPrices(side, type, spec.price);
  return spec;
}

function send(side, forceMarket = false) {
  const s = state.session;
  if (!s || s.finished) return;
  const spec = readTicket(side, forceMarket);
  if (s.coach && s.briefingViewed && Number.isInteger(spec.qty) && spec.qty > 0 && s.isEntry(side, spec.qty)) {
    if (spec.type !== 'MKT' && !Number.isFinite(Number(spec.price))) { msg(`${spec.type} order needs a price`, true); return; }
    coachUi.openTicket(spec);
    return;
  }
  submitSpec(spec);
}

function submitSpec(spec) {
  const s = state.session;
  const side = spec.side;
  const r = s.submit(spec);
  if (!r.ok) msg(r.error, true);
  else if (r.order.status === 'FILLED') msg(`Filled ${side} ${r.order.qty} @ ${s.fmtPx(r.order.fillPrice)}`);
  else msg(`${side} ${r.order.type} #${r.order.id} working`);
  render();
  return r;
}

function flatten() {
  const s = state.session;
  if (!s || s.finished) return;
  const pos = s.account.position;
  s.flatten('flatten');
  msg(pos ? 'Flattened at market.' : 'No position. Working orders cancelled.');
  render();
}

function prefillPrices(force = false) {
  const s = state.session;
  if (force || !$('ordPrice').value) $('ordPrice').value = s.quote().last.toFixed(s.inst.decimals);
}

/** Bracket levels from tick offsets around the entry reference (limit/stop price, or last for market). */
function bracketPrices(side, type, price) {
  const s = state.session, t = s.inst.tick;
  const ref = type === 'MKT' ? s.mark() : Number(price);
  const sl = Math.max(0, Math.round(Number($('slTicks').value) || 0));
  const tp = Math.max(0, Math.round(Number($('tpTicks').value) || 0));
  const dir = side === 'BUY' ? 1 : -1;
  return { stop: sl ? ref - dir * sl * t : null, target: tp ? ref + dir * tp * t : null };
}

function msg(text, err = false) { const el = $('ticketMsg'); el.textContent = text; el.className = `small msg ${err ? 'err' : 'ok'}`; }

// ---------------------------------------------------------------- render
function render() {
  const s = state.session;
  if (!s) return;
  const bars = s.revealedBars();
  const q = s.quote();
  $('clock').textContent = s.clock();
  $('progressFill').style.width = `${s.progress() * 100}%`;
  $('bid').textContent = s.fmtPx(q.bid); $('ask').textContent = s.fmtPx(q.ask); $('last').textContent = s.fmtPx(q.last);
  $('legQuotes').innerHTML = s.inst.kind === 'spread'
    ? s.legQuotes().map((l) => `${l.ratio > 0 ? 'long' : 'short'} ${l.product}: ${l.bid.toFixed(PRODUCTS[l.product].decimals)} / ${l.ask.toFixed(PRODUCTS[l.product].decimals)}`).join(' · ') + ` · spread width ${(q.ask - q.bid).toFixed(s.inst.decimals)}`
    : `spread ${PRODUCTS[s.inst.id].spreadTicks} ticks × ${PRODUCTS[s.inst.id].tick} · ${PRODUCTS[s.inst.id].multiplier.toLocaleString()} ${PRODUCTS[s.inst.id].unit}/contract`;
  const b = bars[state.hover ?? bars.length - 1];
  $('ohlc').textContent = b ? `${b.time}  O ${s.fmtPx(b.o)}  H ${s.fmtPx(b.h)}  L ${s.fmtPx(b.l)}  C ${s.fmtPx(b.c)}${s.inst.kind === 'outright' ? '  V ' + b.v : ''}` : '';

  const levels = s.workingOrders().map((o) => ({ price: o.price, side: o.side, label: `${o.side} ${o.qty} ${o.type}${o.tag ? ' · ' + o.tag : ''}` }));
  if (s.account.position) levels.push({ price: s.account.avgEntry, side: null, label: `entry ${s.account.position > 0 ? '+' : ''}${s.account.position}` });
  const markers = s.tape.filter((t) => t.kind === 'headline' && !t.prior).map((t) => ({ slot: t.item.time.slice(0, 4) + (Number(t.item.time[4]) < 5 ? '0' : '5') }));
  state.chart = drawChart($('chart'), { bars, vwap: vwap(bars), e9: ema(bars, 9), e21: ema(bars, 21), quote: q, levels, markers,
    decimals: s.inst.decimals, tick: s.inst.tick, hover: state.hover });

  renderPosition(); renderOrders(); renderTape(); renderTrades(); renderMargin(); renderControls();
}

function renderControls() {
  const s = state.session;
  $('playBtn').textContent = state.playing ? '❚❚ Pause' : '▶ Play';
  const done = !s || s.finished;
  for (const id of ['playBtn', 'stepBtn', 'buyBtn', 'sellBtn', 'flattenBtn', 'endBtn']) $(id).disabled = done;
}

function renderPosition() {
  const s = state.session, a = s.account;
  const mark = s.mark();
  const unr = a.position ? a.unrealized(mark) : 0;
  const eq = s.equity();
  const mUsed = s.marginUsed();
  const rows = [
    ['Position', `${a.position > 0 ? '+' : ''}${a.position} ${s.inst.id}`],
    ['Entry (avg)', a.avgEntry == null ? '—' : s.fmtPx(a.avgEntry)],
    ['Mark (last)', s.fmtPx(mark)],
    ['Unrealized', `<span class="${cls(unr)}">${money(unr, true)}</span>`],
    ['Realized (net of fees)', `<span class="${cls(a.realizedNet)}">${money(a.realizedNet, true)}</span>`],
    ['Fees paid', money(a.feesPaid)],
    ['Day P&amp;L', `<span class="${cls(eq - a.startingCash)}">${money(eq - a.startingCash, true)}</span>`],
    ['Equity', money(eq)],
    ['Margin used (est.)', money(mUsed)],
    ['Excess equity', money(eq - mUsed)],
  ];
  $('posPanel').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderOrders() {
  const s = state.session;
  const w = s.workingOrders();
  $('orderList').innerHTML = w.length
    ? w.map((o) => `<li><span>#${o.id} ${o.side} ${o.qty} ${o.type} @ ${s.fmtPx(o.price)}${o.tag ? ' <span class="muted">' + esc(o.tag) + '</span>' : ''}</span><button class="btn btn-sm btn-ghost" data-cancel="${o.id}" aria-label="Cancel order ${o.id}">✕</button></li>`).join('')
    : '<li class="empty">None</li>';
}

function renderTape() {
  const s = state.session;
  const items = s.tape.slice().reverse().map((t) => {
    if (t.kind === 'headline') return headlineHtml(t, s.coach ? { index: s.tape.indexOf(t) } : {}); // class-blind renderer, see tape.js
    let tag, body;
    if (t.kind === 'fill') {
      tag = '<span class="tag tag-FILL">FILL</span>';
      const pnl = t.closed.reduce((x, c) => x + c.net, 0);
      body = esc(t.text.replace(/^FILL /, '')) + (t.closed.length ? ` <span class="${cls(pnl)}">${money(pnl, true)} net</span>` : '');
    } else {
      tag = `<span class="tag tag-${t.kind === 'order' ? 'ORDER' : 'SYS'}">${t.kind === 'order' ? 'ORDER' : 'SYS'}</span>`;
      body = esc(t.text);
    }
    return `<li class="${t.prior ? 'prior' : ''}"><span class="t">${t.clock}</span><span>${tag}${body}</span></li>`;
  });
  $('tape').innerHTML = items.join('');
}

function tradeRows(trades, s) {
  const tagCell = (t) => `<td>${s.finished && t.baited ? `<span class="tag tag-BAITED" title="${esc(t.baitHeadline)}">BAITED</span>` : ''}</td>`;
  return trades.map((t) => `<tr><td>${t.entryTime}</td><td>${t.exitTime}</td><td>${t.product}</td><td>${t.side}</td><td class="r">${t.size}</td><td class="r">${s.fmtPx(t.entry)}</td><td class="r">${s.fmtPx(t.exit)}</td><td class="r ${cls(t.gross)}">${money(t.gross, true)}</td><td class="r">${money(t.fees)}</td><td class="r ${cls(t.net)}">${money(t.net, true)}</td>${tagCell(t)}</tr>`).join('');
}
function renderTrades() {
  const s = state.session;
  $('tradeTbl').querySelector('tbody').innerHTML = tradeRows(s.account.trades, s) || '<tr><td colspan="11" class="muted">No closed trades yet.</td></tr>';
}

function renderMargin() {
  const s = state.session;
  const qty = Math.max(0, Number($('qty').value) || 0);
  const m = marginFor(s.inst, qty, s.lastByProduct());
  const fee = feesFor(s.inst, qty);
  const excess = s.equity() - s.marginUsed();
  const bp = $('bracketPreview');
  bp.hidden = !$('bracketChk').checked;
  if (!bp.hidden) {
    const type = $('ordType').value, f = (x) => (x == null ? '—' : s.fmtPx(x));
    const b = bracketPrices('BUY', type, $('ordPrice').value), sl = bracketPrices('SELL', type, $('ordPrice').value);
    bp.textContent = `if BUY: stop ${f(b.stop)} / target ${f(b.target)} · if SELL: stop ${f(sl.stop)} / target ${f(sl.target)}`;
  }
  $('marginInfo').innerHTML = `Est. margin for ${qty}: <span class="mono">${money(m)}</span> · fees/side <span class="mono">${money(fee)}</span> · excess equity <span class="mono">${money(excess)}</span>`;
}

function renderScores() {
  const list = loadScores();
  const row = (r) => `<tr><td>${esc(r.key)}</td><td class="r">${r.sessions}</td><td class="r">${r.trades}</td><td class="r">${r.beatPassive}/${r.sessions}</td><td class="r">${r.herrings}</td><td class="r">${r.baited}</td><td class="r ${cls(r.net)}">${money(r.net, true)}</td></tr>`;
  const empty = (n) => `<tr><td colspan="${n}" class="muted">Finish a session to start scoring.</td></tr>`;
  $('scoreDay').querySelector('tbody').innerHTML = aggregate(list, 'day').map(row).join('') || empty(7);
  $('scoreProd').querySelector('tbody').innerHTML = aggregate(list, 'product').map(row).join('') || empty(7);
  // per session (newest first) + cumulative totals
  const tot = list.reduce((t, x) => ({ net: t.net + x.net, trades: t.trades + x.trades, herrings: t.herrings + (x.herrings || 0), baited: t.baited + (x.baited || 0), passes: t.passes + (x.passes || 0) }), { net: 0, trades: 0, herrings: 0, baited: 0, passes: 0 });
  const scored = list.filter((x) => x.process != null);
  const avgProc = scored.length ? Math.round(scored.reduce((t, x) => t + x.process, 0) / scored.length) : null;
  const status = (x) => `<span class="tag ${x.trained ? 'tag-TRAINED' : 'tag-UNTRAINED'}">${x.trained ? 'TRAINED' : x.mode === 'train' ? 'UNTRAINED' : 'FREE PLAY'}</span>`;
  const sess = list.slice().reverse().map((x) => `<tr><td>${esc((x.playedAt || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(x.day)}</td><td>${esc(x.product)}</td><td>${status(x)}</td><td class="r">${x.trades}</td><td class="r">${x.passes ?? '—'}</td><td class="r">${x.herrings ?? '—'}</td><td class="r">${x.baited ?? '—'}</td><td class="r">${x.process != null ? `${x.processGrade} (${x.process})` : '—'}</td><td class="r">${x.pnlGrade ?? '—'}</td><td class="r ${cls(x.net)}">${money(x.net, true)}</td></tr>`).join('');
  $('scoreSess').querySelector('tbody').innerHTML = sess
    ? `<tr class="total"><td colspan="3">Cumulative (${list.length} sessions)</td><td>${list.filter((x) => x.trained).length} trained</td><td class="r">${tot.trades}</td><td class="r">${tot.passes}</td><td class="r">${tot.herrings}</td><td class="r">${tot.baited}</td><td class="r">${avgProc != null ? `avg ${avgProc}` : '—'}</td><td></td><td class="r ${cls(tot.net)}">${money(tot.net, true)}</td></tr>${sess}`
    : empty(11);
  const sig = Object.entries(mergeSignalStats(list.map((x) => x.bySignal))).sort((a, b2) => b2[1].net - a[1].net);
  $('scoreSig').querySelector('tbody').innerHTML = sig.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.trades}</td><td class="r">${Math.round((v.wins / v.trades) * 100)}%</td><td class="r ${cls(v.net)}">${money(v.net / v.trades, true)}</td><td class="r ${cls(v.net)}">${money(v.net, true)}</td></tr>`).join('') || empty(5);
  if (coachUi) coachUi.renderPath();
}

// ---------------------------------------------------------------- report
function showReport() {
  const s = state.session;
  const c = reportCard(s);
  state.lastCard = c;
  if (!state.reported) { state.scoreId = saveScore(c).at(-1).playedAt; state.reported = true; renderScores(); }
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const stat = (k, v, sub = '', klass = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${klass}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const tr = (t) => (t ? `${t.side} ${t.size} ${t.entryTime}→${t.exitTime}` : '');
  $('reportSub').textContent = `${s.day} · ${s.inst.id} · ${SESSION.open}–${SESSION.close} CT · open positions were flattened at the close`;
  $('reportGrid').innerHTML = [
    stat('Total P&amp;L (net)', money(c.totalNet, true), `P&amp;L grade ${c.pnlGrade}`, cls(c.totalNet)),
    stat('Process', c.process ? `${c.process.grade} · ${c.process.score}` : 'n/a', c.process ? 'graded separately from P&amp;L' : 'free play: coach off'),
    stat('Trades', c.trades),
    stat('Win rate', pct(c.winRate)),
    stat('Avg win / avg loss', `${money(c.avgWin)} / ${money(c.avgLoss)}`, c.avgLoss ? `ratio ${(c.avgWin / Math.abs(c.avgLoss)).toFixed(2)}` : ''),
    stat('Expectancy / trade', money(c.expectancy, true), '', cls(c.expectancy)),
    stat('Max drawdown (intraday)', money(-c.maxDrawdown), 'peak-to-trough equity, marked each bar'),
    stat('Fees paid', money(c.fees)),
    stat('Best trade', c.best ? money(c.best.net, true) : '—', tr(c.best), c.best ? cls(c.best.net) : ''),
    stat('Worst trade', c.worst ? money(c.worst.net, true) : '—', tr(c.worst), c.worst ? cls(c.worst.net) : ''),
    stat('Herrings seen', c.herringsSeen, 'red herrings that printed'),
    stat('Times baited', c.timesBaited, `entries within ${BAIT_WINDOW_MINUTES} min, in the implied direction`, c.timesBaited ? 'down' : ''),
    stat('Baited trades P&amp;L', c.baitedTrades ? money(c.baitedNet, true) : '—', `${c.baitedTrades} baited · other trades ${money(c.cleanNet, true)}`, c.baitedTrades ? cls(c.baitedNet) : ''),
  ].join('');
  const p = c.passiveLong;
  $('benchTbl').querySelector('tbody').innerHTML = [
    ['You', c.totalNet, ''],
    ['Doing nothing', 0, 'stay flat all session'],
    [`Passive long ${p.qty} (held all session)`, p.net, `buy ${s.fmtPx(p.entry)} at open ask + slippage, sell ${s.fmtPx(p.exit)} at close; fees ${money(p.fees)}`],
  ].map(([k, v, note]) => `<tr><td>${k}</td><td class="r ${cls(v)}">${money(v, true)}</td><td class="muted">${esc(note)}</td></tr>`).join('')
    + `<tr><td>Edge vs passive long</td><td class="r ${cls(c.totalNet - p.net)}">${money(c.totalNet - p.net, true)}</td><td></td></tr>`;
  renderAutopsy(c);
  coachUi.renderProcess(c);
  renderTrades();
  $('reportDlg').showModal();
}

function renderAutopsy(c) {
  const s = state.session;
  const rows = c.autopsy.map((a) => {
    const label = `<span class="tag ${a.herring ? 'tag-HERRING' : 'tag-REAL'}">${a.label}</span>`;
    const when = a.prior ? `${esc(a.date.slice(5))} ${esc(a.time)}` : esc(a.time);
    const src = a.source ? ` <span class="muted">· ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.source)}</a>` : esc(a.source)}</span>` : '';
    const note = a.note ? `<div class="muted">${esc(a.note)}</div>` : '';
    const implied = a.herring && a.implies ? `<div class="muted">Tempts you to ${a.implies === 'up' ? 'BUY' : 'SELL'}.</div>` : '';
    const baits = a.baits.map((b) => `<div class="down">BAITED: you ${b.side === 'BUY' ? 'bought' : 'sold'} ${b.qty} @ ${s.fmtPx(b.price)} at ${b.clock}</div>`).join('');
    const passed = a.passed ? `<div class="${a.herring ? 'up' : 'muted'}">You passed (${esc(a.passed)}).${a.herring ? ' Correct: nothing to trade.' : ''}</div>` : '';
    return `<tr><td>${when}</td><td>${label}</td><td><span class="tag tag-${esc(a.type)}">${esc(a.type)}</span>${esc(a.headline)}${src}${note}${implied}${baits}${passed}</td></tr>`;
  });
  $('autopsyTbl').querySelector('tbody').innerHTML = rows.join('') || '<tr><td colspan="3" class="muted">No headlines printed in this session.</td></tr>';
  const real = c.autopsy.length - c.herringsSeen;
  $('autopsySum').textContent = `${c.autopsy.length} headlines printed: ${real} real, ${c.herringsSeen} red herrings. Times baited: ${c.timesBaited}.`
    + (c.baitedTrades ? ` Baited trades: ${c.baitedTrades}, ${money(c.baitedNet, true)} net (all other trades ${money(c.cleanNet, true)}).` : '');
}

function downloadCsv() {
  const s = state.session;
  const c = s.finished ? state.lastCard || reportCard(s) : null;
  const csv = tradesToCsv(s.account.trades, s.day, s.inst.decimals,
    c ? { finished: true, herringsSeen: c.herringsSeen, timesBaited: c.timesBaited, product: s.inst.id, mode: c.mode, trained: state.trained,
      passes: c.passes, processScore: c.process?.score, processGrade: c.process?.grade, pnlGrade: c.pnlGrade, debrief: state.debrief } : null);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `replaydesk_${s.day}_${s.inst.id}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- events
function wire() {
  $('loadBtn').onclick = () => loadDay($('daySel').value);
  $('modeSel').onchange = () => {
    state.mode = $('modeSel').value;
    try { localStorage.setItem('replaydesk.mode', state.mode); } catch { /* not persisted */ }
    loadDay($('daySel').value);
    $('modeSel').value = state.session.coach ? 'train' : 'free';
    state.mode = $('modeSel').value;
  };
  $('tape').onclick = (e) => {
    const b = e.target.closest('[data-pass]');
    if (!b) return;
    if (state.session.pass(Number(b.dataset.pass), b.dataset.reason || '')) render();
  };
  $('playBtn').onclick = toggle;
  $('stepBtn').onclick = () => { if (coachUi.blocked()) return; stop(); advance(1); };
  $('resumeBtn').onclick = play;
  $('endBtn').onclick = () => { const s = state.session; if (!s || s.finished) return; if (!confirm('End the session now? Open positions are flattened at the current bar.')) return; stop(); s.finish(); render(); showReport(); };
  $('speeds').onclick = (e) => { const b = e.target.closest('[data-speed]'); if (b) setSpeed(Number(b.dataset.speed)); };
  $('buyBtn').onclick = () => send('BUY');
  $('sellBtn').onclick = () => send('SELL');
  $('flattenBtn').onclick = flatten;
  $('ordType').onchange = () => { $('priceWrap').hidden = $('ordType').value === 'MKT'; prefillPrices(true); };
  $('bracketChk').onchange = () => { $('bracketRow').hidden = !$('bracketChk').checked; prefillPrices(true); };
  $('qty').oninput = renderMargin;
  for (const id of ['slTicks', 'tpTicks', 'ordPrice']) $(id).oninput = renderMargin;
  $('orderList').onclick = (e) => { const b = e.target.closest('[data-cancel]'); if (b) { state.session.cancel(Number(b.dataset.cancel)); render(); } };
  $('csvBtn').onclick = downloadCsv;
  $('reportCsvBtn').onclick = downloadCsv;
  $('clearScoresBtn').onclick = () => { if (confirm('Clear the scoreboard for all sessions?')) { clearScores(); renderScores(); } };
  const cv = $('chart');
  cv.onmousemove = (e) => {
    if (!state.chart) return;
    const slot = state.chart.slotFromX(e.offsetX);
    const t = state.chart.slots[slot];
    const idx = state.session.revealedBars().findIndex((b) => b.time === t);
    state.hover = idx >= 0 ? idx : null; render();
  };
  cv.onmouseleave = () => { state.hover = null; render(); };
  window.addEventListener('resize', () => render());

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (coachUi.blocked() && k !== 'f' && k !== 'F') { if (k === ' ') e.preventDefault(); return; }
    if (k === ' ') { e.preventDefault(); toggle(); }
    else if (k === 'b' || k === 'B') send('BUY', true);
    else if (k === 's' || k === 'S') send('SELL', true);
    else if (k === 'f' || k === 'F') flatten();
    else if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); stop(); advance(e.shiftKey ? 6 : 1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); msg('No rewinding. The tape only runs forward.', true); }
  });
  const build = document.querySelector('meta[name=replay-desk-build]')?.content;
  if (build && !build.startsWith('__')) $('buildId').textContent = `Build ${build}.`;
}

boot();

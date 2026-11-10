// REPLAY DESK UI wiring. All market data shown comes from Session's revealed accessors.
import { PRODUCTS, SPREADS, SPEEDS, ACCOUNT, SESSION } from './config.js';
import { Session } from './session.js';
import { vwap, ema } from './indicators.js';
import { marginFor, feesFor } from './instruments.js';
import { drawChart, sessionSlots } from './chart.js';
import { reportCard, tradesToCsv, loadScores, saveScore, clearScores, aggregate } from './report.js';

const $ = (id) => document.getElementById(id);
const state = { manifest: null, headlines: [], data: {}, session: null, playing: false, speed: 0, timer: null, hover: null, reported: false, lastCard: null };

const money = (n, sign = false) => {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}$${s}`;
};
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  wire();
  newSession();
  renderScores();
}

function availableDays(inst) {
  const legs = PRODUCTS[inst] ? [inst] : SPREADS[inst].legs.map((l) => l.product);
  return legs.map((p) => state.manifest.products[p].days).reduce((a, b) => a.filter((d) => b.includes(d)));
}

function newSession() {
  stop();
  const day = $('daySel').value, inst = $('instSel').value;
  const days = availableDays(inst);
  if (!days.includes(day)) { msg(`${inst} has no data for ${day}`, true); return; }
  const legs = PRODUCTS[inst] ? [inst] : SPREADS[inst].legs.map((l) => l.product);
  const dayBars = Object.fromEntries(legs.map((p) => [p, state.data[p].days[day]]));
  const prevDay = days[days.indexOf(day) - 1] ?? null;
  state.session = new Session({ day, instrumentId: inst, dayBars, headlines: state.headlines, prevDay });
  state.reported = false; state.lastCard = null;
  $('banner').hidden = true;
  $('clockDay').textContent = day;
  $('instName').textContent = `${state.session.inst.id} · ${state.session.inst.name}`;
  const step = state.session.inst.tick;
  $('ordPrice').step = String(step);
  buildProgressTicks();
  prefillPrices(true);
  msg('Session loaded. Flat, $' + ACCOUNT.startingCash.toLocaleString() + ' paper account.');
  render();
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
  if (!s || s.finished) return;
  $('banner').hidden = true;
  state.playing = true; schedule(); renderControls();
}
function stop() { state.playing = false; clearTimeout(state.timer); renderControls(); }
function toggle() { state.playing ? stop() : play(); }
function schedule() { state.timer = setTimeout(() => { advance(1); if (state.playing) schedule(); }, SPEEDS[state.speed].msPerBar); }

function advance(n) {
  const s = state.session;
  if (!s || s.finished) return;
  $('banner').hidden = true;
  for (let k = 0; k < n; k++) {
    const r = s.step();
    if (s.isLastBar) { s.finish(); }
    if (s.finished) { stop(); render(); showReport(); return; }
    if (r.pauseEvent) { stop(); showBanner(r.pauseEvent); break; }
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
  if (!s) return;
  const r = s.submit(readTicket(side, forceMarket));
  if (!r.ok) msg(r.error, true);
  else if (r.order.status === 'FILLED') msg(`Filled ${side} ${r.order.qty} @ ${s.fmtPx(r.order.fillPrice)}`);
  else msg(`${side} ${r.order.type} #${r.order.id} working`);
  render();
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
    let tag, body;
    if (t.kind === 'headline') {
      const h = t.item;
      tag = `<span class="tag tag-${esc(h.type)}">${esc(h.type)}</span>`;
      const when = t.prior ? `<span class="muted">${esc(h.date.slice(5))} ${esc(h.time)} · since prior close · </span>` : '';
      const approx = h.time_precision === 'approx' ? ' <span class="muted">(time approx.)</span>' : '';
      body = `${when}${esc(h.headline)}${approx}${h.source ? ` <span class="muted">· ${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.source)}</a>` : esc(h.source)}</span>` : ''}`;
    } else if (t.kind === 'fill') {
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
  return trades.map((t) => `<tr><td>${t.entryTime}</td><td>${t.exitTime}</td><td>${t.product}</td><td>${t.side}</td><td class="r">${t.size}</td><td class="r">${s.fmtPx(t.entry)}</td><td class="r">${s.fmtPx(t.exit)}</td><td class="r ${cls(t.gross)}">${money(t.gross, true)}</td><td class="r">${money(t.fees)}</td><td class="r ${cls(t.net)}">${money(t.net, true)}</td></tr>`).join('');
}
function renderTrades() {
  const s = state.session;
  $('tradeTbl').querySelector('tbody').innerHTML = tradeRows(s.account.trades, s) || '<tr><td colspan="10" class="muted">No closed trades yet.</td></tr>';
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
  const row = (r) => `<tr><td>${esc(r.key)}</td><td class="r">${r.sessions}</td><td class="r">${r.trades}</td><td class="r">${r.beatPassive}/${r.sessions}</td><td class="r ${cls(r.net)}">${money(r.net, true)}</td></tr>`;
  const empty = '<tr><td colspan="5" class="muted">Finish a session to start scoring.</td></tr>';
  $('scoreDay').querySelector('tbody').innerHTML = aggregate(list, 'day').map(row).join('') || empty;
  $('scoreProd').querySelector('tbody').innerHTML = aggregate(list, 'product').map(row).join('') || empty;
}

// ---------------------------------------------------------------- report
function showReport() {
  const s = state.session;
  const c = reportCard(s);
  state.lastCard = c;
  if (!state.reported) { saveScore(c); state.reported = true; renderScores(); }
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const stat = (k, v, sub = '', klass = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${klass}">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const tr = (t) => (t ? `${t.side} ${t.size} ${t.entryTime}→${t.exitTime}` : '');
  $('reportSub').textContent = `${s.day} · ${s.inst.id} · ${SESSION.open}–${SESSION.close} CT · open positions were flattened at the close`;
  $('reportGrid').innerHTML = [
    stat('Total P&amp;L (net)', money(c.totalNet, true), '', cls(c.totalNet)),
    stat('Trades', c.trades),
    stat('Win rate', pct(c.winRate)),
    stat('Avg win / avg loss', `${money(c.avgWin)} / ${money(c.avgLoss)}`, c.avgLoss ? `ratio ${(c.avgWin / Math.abs(c.avgLoss)).toFixed(2)}` : ''),
    stat('Expectancy / trade', money(c.expectancy, true), '', cls(c.expectancy)),
    stat('Max drawdown (intraday)', money(-c.maxDrawdown), 'peak-to-trough equity, marked each bar'),
    stat('Fees paid', money(c.fees)),
    stat('Best trade', c.best ? money(c.best.net, true) : '—', tr(c.best), c.best ? cls(c.best.net) : ''),
    stat('Worst trade', c.worst ? money(c.worst.net, true) : '—', tr(c.worst), c.worst ? cls(c.worst.net) : ''),
  ].join('');
  const p = c.passiveLong;
  $('benchTbl').querySelector('tbody').innerHTML = [
    ['You', c.totalNet, ''],
    ['Doing nothing', 0, 'stay flat all session'],
    [`Passive long ${p.qty} (held all session)`, p.net, `buy ${s.fmtPx(p.entry)} at open ask + slippage, sell ${s.fmtPx(p.exit)} at close; fees ${money(p.fees)}`],
  ].map(([k, v, note]) => `<tr><td>${k}</td><td class="r ${cls(v)}">${money(v, true)}</td><td class="muted">${esc(note)}</td></tr>`).join('')
    + `<tr><td>Edge vs passive long</td><td class="r ${cls(c.totalNet - p.net)}">${money(c.totalNet - p.net, true)}</td><td></td></tr>`;
  $('reportDlg').showModal();
}

function downloadCsv() {
  const s = state.session;
  const csv = tradesToCsv(s.account.trades, s.day, s.inst.decimals);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `replaydesk_${s.day}_${s.inst.id}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- events
function wire() {
  $('loadBtn').onclick = () => {
    const s = state.session;
    if (s && !s.finished && (s.account.position || s.account.fills.length) && !confirm('Abandon the current session? It will not be scored.')) return;
    newSession();
  };
  $('playBtn').onclick = toggle;
  $('stepBtn').onclick = () => { stop(); advance(1); };
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
    if ($('reportDlg').open) return;
    const k = e.key;
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

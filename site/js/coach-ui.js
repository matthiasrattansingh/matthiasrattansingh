// COACH layer UI: briefing, trade ticket, coach cards, training path, process report,
// guided debrief and the coach replay. Logic lives in coach.js / coachbot.js.
import { COACH } from './config.js';
import { SIGNALS, SIZES, NO_SIGNAL, NO_SIGNAL_WARNING, DEBRIEF_QUESTIONS, briefingHtml, carriedRule, debriefPrefill,
  namedDriver, saveJournal, isTrained, coachVerdict } from './coach.js';
import { esc } from './tape.js';
import { runCoach } from './coachbot.js';
import { drawChart } from './chart.js';
import { vwap, ema } from './indicators.js';
import { updateScore, loadScores } from './report.js';

export function initCoachUi(ctx) {
  const { state, $, money, cls } = ctx;
  const ui = { cards: [], resume: false, ticket: null, run: null, k: 0 };
  const opts = (list, placeholder) => `<option value="">${placeholder}</option>` + list.map((x) => `<option>${esc(x)}</option>`).join('');
  $('tkSignal').innerHTML = opts(SIGNALS, 'Pick one');
  $('tkSize').innerHTML = opts(SIZES, 'Pick one');

  // ------------------------------------------------------------ briefing
  function showBriefing() {
    const s = state.session;
    const overnight = s.tape.filter((t) => t.kind === 'headline').map((t) => ({ when: t.prior ? `${t.item.date.slice(5)} ${t.item.time}` : t.item.time, text: t.item.headline }));
    $('briefSub').textContent = `${s.day} · ${s.inst.id}`;
    const body = $('briefBody');
    body.innerHTML = briefingHtml({ day: s.day, product: s.inst.id, coachDay: state.coach[s.day], carried: carriedRule(), priorClose: ctx.priorClose(s), overnight });
    body.scrollTop = 0;
    $('briefOk').disabled = true;
    $('briefHint').hidden = false;
    $('briefDlg').showModal();
    requestAnimationFrame(checkBriefScroll);
  }
  function checkBriefScroll() {
    const b = $('briefBody');
    if (b.scrollTop + b.clientHeight >= b.scrollHeight - 12) { $('briefOk').disabled = false; $('briefHint').hidden = true; }
  }
  $('briefBody').addEventListener('scroll', checkBriefScroll);
  $('briefDlg').addEventListener('cancel', (e) => e.preventDefault());
  $('briefOk').onclick = () => {
    state.session.briefingViewed = true;
    $('briefDlg').close();
    ctx.msg('Briefing read. Trading unlocked. Every entry needs a ticket; PASS is a decision too.');
  };

  // ------------------------------------------------------------ trade ticket
  function openTicket(spec) {
    const s = state.session;
    const q = s.quote();
    const ref = spec.type === 'MKT' ? q.last : Number(spec.price);
    const dir = spec.side === 'BUY' ? 1 : -1;
    const headlineBar = s.tape.some((t) => t.kind === 'headline' && !t.prior && t.clock === s.clock());
    ui.ticket = { spec, wasPlaying: state.playing, headlineBar, skipped: false, pauseUntil: Date.now() + COACH.headlinePauseMs, noneUntil: 0 };
    ctx.stop();
    $('tkSub').textContent = `${s.clock()} CT · ${spec.side} ${spec.qty} ${s.inst.id} ${spec.type === 'MKT' ? `at market (bid ${s.fmtPx(q.bid)} / ask ${s.fmtPx(q.ask)})` : `${spec.type} @ ${s.fmtPx(ref)}`}`;
    $('tkPricing').value = ''; $('tkSignal').value = ''; $('tkSize').value = ''; $('tkAttach').checked = true;
    $('tkWrong').step = String(s.inst.tick);
    $('tkWrong').value = (spec.bracket?.stop ?? ref - dir * 20 * s.inst.tick).toFixed(s.inst.decimals);
    $('tkErr').textContent = '';
    $('tkWarn').hidden = true;
    $('tkPause').hidden = !headlineBar;
    if (headlineBar) $('tkPause').innerHTML = 'A headline printed this bar. Take five seconds: new information, or already in the price? <button type="button" class="chip" id="tkSkip">Skip the pause (scored as impulse)</button>';
    $('ticketDlg').showModal();
    $('tkPricing').focus();
    tickTicket();
  }
  function tickTicket() {
    const t = ui.ticket;
    if (!t || !$('ticketDlg').open) return;
    const now = Date.now();
    const waits = [];
    if ($('tkSignal').value === NO_SIGNAL) waits.push(t.noneUntil - now);
    if (t.headlineBar && !t.skipped) waits.push(t.pauseUntil - now);
    const wait = Math.max(0, ...waits);
    $('tkOk').disabled = wait > 0;
    $('tkOk').textContent = wait > 0 ? `Place order (${Math.ceil(wait / 1000)}s)` : 'Place order';
    const lock = state.session.lockout();
    $('tkLock').hidden = !lock;
    if (lock) $('tkLock').textContent = `Stopped out at ${lock.clock}. Re-entry locked ${fmtMs(lock.remainingMs)}. A different signal than "${lock.signal}" overrides.`;
    setTimeout(tickTicket, 200);
  }
  $('tkSignal').onchange = () => {
    const none = $('tkSignal').value === NO_SIGNAL;
    $('tkWarn').hidden = !none;
    $('tkWarn').textContent = NO_SIGNAL_WARNING;
    if (none) { ui.ticket.noneUntil = Date.now() + COACH.noSignalDelayMs; $('tkOk').disabled = true; $('tkOk').textContent = `Place order (${Math.ceil(COACH.noSignalDelayMs / 1000)}s)`; }
  };
  $('ticketDlg').addEventListener('click', (e) => { if (e.target.id === 'tkSkip') { ui.ticket.skipped = true; $('tkPause').hidden = true; } });
  const closeTicket = () => {
    const was = ui.ticket?.wasPlaying;
    ui.ticket = null;
    $('ticketDlg').close();
    if (was) ctx.play();
  };
  $('tkCancel').onclick = closeTicket;
  $('ticketDlg').addEventListener('cancel', (e) => { e.preventDefault(); closeTicket(); });
  $('tkOk').onclick = () => {
    const t = ui.ticket;
    const ticket = { pricing: $('tkPricing').value, signal: $('tkSignal').value, wrong: $('tkWrong').value, size: $('tkSize').value,
      attachStop: $('tkAttach').checked, headlinePause: t.headlineBar && !t.skipped };
    const r = ctx.submit({ ...t.spec, ticket });
    if (!r.ok) { $('tkErr').textContent = r.error; return; }
    closeTicket();
  };

  // ------------------------------------------------------------ coach cards
  function queueCards(cards, wasPlaying) {
    if (!cards.length) return;
    if (!ui.cards.length) ui.resume = wasPlaying;
    ui.cards.push(...cards);
    showCard();
  }
  function showCard() {
    const c = ui.cards[0];
    $('coachCard').hidden = !c;
    if (!c) { if (ui.resume) { ui.resume = false; ctx.play(); } return; }
    $('coachText').textContent = c.text;
    $('coachBtns').innerHTML = (c.answers.length ? c.answers : ['Got it']).map((a) => `<button type="button" class="btn btn-sm${c.answers.length ? '' : ' btn-primary'}" data-answer="${esc(a)}">${esc(a)}</button>`).join('');
  }
  $('coachBtns').onclick = (e) => {
    const b = e.target.closest('[data-answer]');
    if (!b || !ui.cards.length) return;
    const c = ui.cards.shift();
    state.session.answerCard(c.id, c.answers.length ? b.dataset.answer : null);
    showCard();
  };
  function reset() { ui.cards = []; ui.resume = false; ui.run = null; $('coachCard').hidden = true; }
  const blocked = () => ui.cards.length > 0 || Boolean(document.querySelector('dialog[open]'));

  function tickLock() {
    const s = state.session;
    const lock = s && s.coach && !s.finished ? s.lockout() : null;
    $('lockInfo').hidden = !lock;
    if (lock) $('lockInfo').textContent = `Stopped out at ${lock.clock}. Re-entry locked ${fmtMs(lock.remainingMs)}; a ticket with a different signal overrides.`;
  }
  setInterval(tickLock, 500);

  // ------------------------------------------------------------ training path
  function renderPath() {
    const train = state.mode === 'train';
    const days = Object.keys(state.coach).sort();
    const done = new Set(loadScores().filter((x) => x.trained).map((x) => x.day));
    const next = days.find((d) => !done.has(d));
    $('pathSum').textContent = train ? `${days.filter((d) => done.has(d)).length} of ${days.length} days trained` : 'Free play: coach off, sessions are labeled untrained';
    $('pathList').innerHTML = days.map((d, i) => `<li class="${done.has(d) ? 'done' : ''}${d === next ? ' next' : ''}"><button type="button" data-day="${d}"><span class="d">${i + 1} · ${d} · ${done.has(d) ? 'TRAINED' : d === next ? 'NEXT' : 'not trained'}</span>${esc(state.coach[d].lesson)}</button></li>`).join('');
    return next;
  }
  $('pathList').onclick = (e) => {
    const b = e.target.closest('[data-day]');
    if (b) ctx.loadDay(b.dataset.day);
  };

  // ------------------------------------------------------------ report additions
  function renderProcess(c) {
    const s = state.session;
    const p = c.process;
    $('processBox').hidden = !p;
    setTrainedTag();
    $('debriefBtn').hidden = !p;
    if (!p) return;
    $('coachVerdict').textContent = coachVerdict(s, c, p);
    const rows = [
      ['P&amp;L grade', `<strong>${c.pnlGrade}</strong>`, `${money(c.totalNet, true)} on a $${s.account.startingCash.toLocaleString()} account`],
      ['Process grade', `<strong>${p.grade}</strong>`, `${p.score} / 100, starting from 100`],
      ...p.items.map((i) => [esc(i.label), `<span class="${cls(i.points)}">${i.points > 0 ? '+' : ''}${i.points}</span>`, esc(i.detail)]),
      ['Headlines passed', c.passes, s.passes.map((x) => `${x.printedClock}${x.reason ? ' ' + esc(x.reason) : ''}`).join(' · ') || 'none'],
      ['Coach cards', s.coachLog.length, s.coachLog.filter((x) => x.answer).map((x) => `${x.clock} ${esc(x.print || '')}: ${esc(x.answer)}`).join(' · ') || 'no answers logged'],
    ];
    $('processTbl').querySelector('tbody').innerHTML = rows.map(([k, v, d]) => `<tr><td>${k}</td><td class="r">${v}</td><td class="muted">${d}</td></tr>`).join('');
    $('sigTbl').querySelector('tbody').innerHTML = Object.entries(c.bySignal).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${v.trades}</td><td class="r">${v.wins}</td><td class="r ${cls(v.net)}">${money(v.net, true)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No closed trades.</td></tr>';
  }
  function setTrainedTag() {
    const trained = Boolean(state.trained);
    $('trainedTag').textContent = trained ? 'TRAINED' : 'UNTRAINED';
    $('trainedTag').className = `tag ${trained ? 'tag-TRAINED' : 'tag-UNTRAINED'}`;
    $('debriefBtn').textContent = state.debrief ? 'Debrief saved' : 'Guided debrief';
    $('debriefBtn').disabled = Boolean(state.debrief);
  }

  // ------------------------------------------------------------ guided debrief
  function openDebrief() {
    const s = state.session, c = state.lastCard;
    const pre = debriefPrefill(s, c.process);
    $('dbSub').textContent = `${s.day} · ${s.inst.id}`;
    $('dbBody').innerHTML = DEBRIEF_QUESTIONS.map((q, i) => `<label>${i + 1}. ${esc(q)} <span class="pre">${esc(pre[i])}</span><input type="text" id="db${i}" maxlength="240" autocomplete="off"></label>${i === 0 ? '<div><button type="button" class="btn btn-sm" id="dbReveal">Lock my answer and reveal the driver</button></div><div id="dbDriver" class="reveal" hidden></div>' : ''}`).join('');
    $('dbErr').textContent = '';
    ui.named = null;
    $('dbReveal').onclick = () => {
      const a = $('db0').value.trim();
      if (!a) { $('dbErr').textContent = 'Answer question 1 first. Then the driver is revealed.'; return; }
      $('dbErr').textContent = '';
      $('db0').readOnly = true;
      const day = state.coach[s.day] || {};
      ui.named = namedDriver(a, day.driver_keywords);
      $('dbDriver').hidden = false;
      $('dbDriver').innerHTML = `${esc(day.driver_summary || 'No driver summary written for this day.')}<div class="small">Named it: <button type="button" class="chip on" id="dbNamed"></button> <span class="muted">(tap to change)</span></div>`;
      const paint = () => { $('dbNamed').textContent = ui.named ? 'YES' : 'NO'; };
      paint();
      $('dbNamed').onclick = () => { ui.named = !ui.named; paint(); };
      $('dbReveal').hidden = true;
    };
    $('debriefDlg').showModal();
  }
  $('dbCancel').onclick = () => $('debriefDlg').close();
  $('dbSave').onclick = () => {
    const s = state.session;
    const answers = DEBRIEF_QUESTIONS.map((_, i) => $(`db${i}`).value.trim());
    if (ui.named == null) { $('dbErr').textContent = 'Reveal the driver under question 1 first.'; return; }
    if (answers.some((a) => !a)) { $('dbErr').textContent = 'All five need an answer. One line each.'; return; }
    state.debrief = { answers, named: ui.named };
    saveJournal({ playedAt: state.scoreId, day: s.day, product: s.inst.id, answers, named: ui.named, rule: answers[4] });
    state.trained = isTrained(s, true);
    updateScore(state.scoreId, { trained: state.trained, namedDriver: ui.named });
    ctx.renderScores(); renderPath(); setTrainedTag();
    $('debriefDlg').close();
    ctx.msg(state.trained ? 'Debrief saved. Session logged as trained. Your rule opens the next briefing.' : 'Debrief saved. Not trained: no ticket or pass was logged this session.');
  };

  // ------------------------------------------------------------ coach replay
  function openCoachReplay() {
    const s = state.session;
    if (!ui.run) ui.run = runCoach({ day: s.day, instrumentId: s.inst.id, dayBars: ctx.dayBars(s), scheduled: ctx.scheduled(s) });
    ui.k = 0;
    $('crSub').textContent = `${s.day} · ${s.inst.id}`;
    $('coachDlg').showModal();
    drawReplay();
  }
  function drawReplay() {
    const s = state.session, r = ui.run, k = ui.k;
    const bars = r.bars.slice(0, k + 1);
    const f = r.frames[k];
    const last = bars.at(-1).c;
    const levels = [];
    if (f.entry != null) levels.push({ price: f.entry, side: null, label: `coach ${f.position > 0 ? 'long' : 'short'}` });
    if (f.stop != null && f.position) levels.push({ price: f.stop, side: f.position > 0 ? 'SELL' : 'BUY', label: 'coach stop' });
    drawChart($('crChart'), { bars, vwap: vwap(bars), e9: ema(bars, 9), e21: ema(bars, 21), quote: { bid: last, ask: last }, levels, markers: [],
      decimals: s.inst.decimals, tick: s.inst.tick, hover: null });
    const mine = s.account.fills.map((x) => ({ clock: x.time, who: 'YOU', text: `${x.time}: you ${x.side === 'BUY' ? 'bought' : 'sold'} ${x.qty} @ ${s.fmtPx(x.price)} (${x.reason}).` }));
    const lines = [...r.notes.map((n) => ({ clock: n.clock, who: 'COACH', text: n.text })), ...mine]
      .filter((n) => n.clock <= f.clock).sort((a, b) => (a.clock < b.clock ? -1 : a.clock > b.clock ? 1 : 0));
    $('crNotes').innerHTML = lines.map((n) => `<li><span class="t">${n.clock}</span><span><span class="tag tag-${n.who}">${n.who}</span>${esc(n.text.replace(/^\d\d:\d\d: /, ''))}</span></li>`).join('');
    $('crNotes').scrollTop = $('crNotes').scrollHeight;
    $('crState').textContent = `${f.clock} CT · coach ${f.position ? (f.position > 0 ? 'long 1' : 'short 1') : 'flat'} · coach day ${money(f.equity - s.account.startingCash, true)}${k === r.frames.length - 1 ? ` · final ${money(r.net, true)}` : ''}`;
    $('crBack').disabled = k === 0;
    $('crStep').disabled = $('crNext').disabled = k >= r.frames.length - 1;
  }
  $('crBack').onclick = () => { ui.k = Math.max(0, ui.k - 1); drawReplay(); };
  $('crStep').onclick = () => { ui.k = Math.min(ui.run.frames.length - 1, ui.k + 1); drawReplay(); };
  $('crNext').onclick = () => {
    const r = ui.run;
    let k = ui.k + 1;
    while (k < r.frames.length - 1 && !r.notes.some((n) => n.clock === r.frames[k].clock)) k += 1;
    ui.k = Math.min(k, r.frames.length - 1); drawReplay();
  };
  $('crClose').onclick = () => $('coachDlg').close();
  $('debriefBtn').onclick = openDebrief;
  $('coachReplayBtn').onclick = openCoachReplay;

  return { showBriefing, openTicket, queueCards, reset, blocked, renderPath, renderProcess };
}

function fmtMs(ms) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

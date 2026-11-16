/* OMR Fill – app logic (vanilla JS, no dependencies)
 * v2: multiple mocks, per-question time tracking, charts.
 */
(() => {
  'use strict';

  const STORE_KEY = 'omrfill:v2';
  const OLD_KEY = 'omrfill:v1';
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];
  const SETTINGS = ['theme', 'sound', 'haptics', 'autoNext', 'instant'];
  const MAX_GAP_MS = 180000; // idle cap for per-question time (3 min)

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, min, max, d) => {
    const x = parseFloat(v);
    return Number.isNaN(x) ? d : Math.min(max, Math.max(min, x));
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const defaults = () => ({
    name: '', roll: '', title: 'Mock Test',
    n: 50, opts: 4, plus: 4, minus: 1, timerMin: 0,
    theme: 'dark', sound: true, haptics: true, autoNext: true, instant: false,
    tab: 'sheet', filter: 'all',
    answers: {}, key: {}, review: {}, qtime: {},
    startedAt: null, submittedAt: null, submitted: false,
  });

  /* ---------- storage (multi-mock) ---------- */
  function loadStore() {
    try {
      const st = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (st && Array.isArray(st.mocks) && st.mocks.length) {
        if (!st.mocks.find((m) => m.id === st.activeId)) st.activeId = st.mocks[0].id;
        return st;
      }
    } catch (e) { /* fall through to migration */ }
    // Migrate the single-sheet v1 data into "Mock 1"
    let old = null;
    try { old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); } catch (e) { old = null; }
    const id = newId();
    return { v: 2, activeId: id, mocks: [{ id, name: 'Mock 1', createdAt: Date.now(), data: Object.assign(defaults(), old || {}) }] };
  }

  let store = loadStore();
  const activeMock = () => store.mocks.find((m) => m.id === store.activeId);
  let S = Object.assign(defaults(), activeMock().data);

  function save() {
    const m = activeMock();
    if (m) m.data = S;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage full / disabled */ }
  }

  const undoStack = [];
  let deferredPrompt = null;
  let tickId = null;
  let curQ = null;      // question currently being worked on (for per-question time)
  let curQStart = 0;

  /* ---------- helpers ---------- */
  const validLetters = () => LETTERS.slice(0, S.opts);
  const bucket = () => (S.tab === 'key' ? S.key : S.answers);
  const countOf = (obj, n = S.n) => Object.keys(obj).filter((q) => +q >= 1 && +q <= n && obj[q]).length;

  function prune() {
    const ok = validLetters();
    for (const obj of [S.answers, S.key]) {
      for (const q of Object.keys(obj)) {
        if (+q > S.n || +q < 1 || !ok.includes(obj[q])) delete obj[q];
      }
    }
    for (const q of Object.keys(S.review)) if (+q > S.n || +q < 1) delete S.review[q];
    for (const q of Object.keys(S.qtime)) if (+q > S.n || +q < 1) delete S.qtime[q];
  }

  function fmt(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 1700);
  }

  let actx = null;
  function beep() {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      const t = actx.currentTime;
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + 0.09);
    } catch (e) { /* audio not available */ }
  }
  function buzz(ms = 12) {
    if (S.haptics && navigator.vibrate) navigator.vibrate(ms);
  }

  /* ---------- per-question time ---------- */
  // Time for a question = gap from first touching it to touching the next question
  // (each gap capped at 3 min so idle time does not inflate the numbers).
  function flushQ() {
    if (curQ && !S.submitted) {
      const d = Math.min(MAX_GAP_MS, Math.max(0, Date.now() - curQStart));
      S.qtime[curQ] = (S.qtime[curQ] || 0) + d;
    }
    curQ = null;
  }
  function touchQ(q) {
    if (S.submitted || curQ === q) return;
    flushQ();
    curQ = q;
    curQStart = Date.now();
  }

  /* ---------- scoring ---------- */
  function computeScore(D = S) {
    let c = 0, w = 0, u = 0, nk = 0;
    const rows = [];
    for (let q = 1; q <= D.n; q++) {
      const a = D.answers[q] || '';
      const k = D.key[q] || '';
      let st;
      if (!a) { u++; st = 'skipped'; }
      else if (!k) { nk++; st = 'nokey'; }
      else if (a === k) { c++; st = 'correct'; }
      else { w++; st = 'wrong'; }
      rows.push({ q, a, k, st });
    }
    const s = c * D.plus - w * D.minus;
    const max = D.n * D.plus;
    const pct = max > 0 ? (s / max) * 100 : 0;
    const acc = c + w > 0 ? Math.round((c / (c + w)) * 100) : 0;
    return { c, w, u, nk, s, max, pct, acc, rows, keyFilled: countOf(D.key, D.n) };
  }
  const markOf = (st) => (st === 'correct' ? S.plus : st === 'wrong' ? -S.minus : 0);
  const labelOf = (st) => ({ correct: '✓ Correct', wrong: '✗ Wrong', skipped: '– Skipped', nokey: '? No key' }[st]);

  /* ---------- undo ---------- */
  function pushUndo() {
    undoStack.push(JSON.stringify({ answers: S.answers, key: S.key, review: S.review }));
    if (undoStack.length > 100) undoStack.shift();
  }
  function undo() {
    if (S.submitted && S.tab === 'sheet') return toast('Sheet is submitted. Re-open to edit.');
    if (!undoStack.length) return toast('Nothing to undo');
    const snap = JSON.parse(undoStack.pop());
    S.answers = snap.answers; S.key = snap.key; S.review = snap.review;
    save(); renderAll();
    toast('Undone');
  }

  /* ---------- fill actions ---------- */
  function fill(q, o) {
    if (S.submitted && S.tab === 'sheet') return toast('Sheet is submitted. Re-open to edit.');
    const b = bucket();
    if (S.tab === 'sheet') touchQ(q);
    pushUndo();
    if (b[q] === o) delete b[q];
    else b[q] = o;
    const filled = b[q] === o;
    if (S.tab === 'sheet' && !S.startedAt && countOf(S.answers) > 0) {
      S.startedAt = Date.now();
      startTick();
    }
    buzz();
    if (filled) beep();
    save();
    renderSheet();
    if (filled && S.autoNext) scrollToQ(q + 1, true);
  }

  function toggleReview(q) {
    if (S.submitted && S.tab === 'sheet') return toast('Sheet is submitted.');
    touchQ(q);
    pushUndo();
    if (S.review[q]) delete S.review[q]; else S.review[q] = true;
    buzz(8);
    save();
    renderSheet();
  }

  function scrollToQ(q, smooth = false) {
    const el = $('#q' + q);
    if (!el) return false;
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    return true;
  }

  /* ---------- rendering: sheet ---------- */
  function applyTheme() {
    document.documentElement.dataset.theme = S.theme;
    const meta = $('#themeMeta');
    if (meta) meta.setAttribute('content', S.theme === 'light' ? '#f3f5fb' : '#0b1020');
  }

  function rowHTML(q, val, isRev, isKey, locked) {
    // Instant check: colour right/wrong as soon as answer is filled (needs key + toggle on)
    const showRes = (S.submitted || S.instant) && !isKey;
    const k = showRes ? S.key[q] : undefined;
    let cls = '';
    if (k) {
      if (!val) cls = S.submitted ? 'skip' : '';
      else cls = val === k ? 'right' : 'wrong';
    }
    const bubs = validLetters().map((L) => {
      const on = val === L;
      const isAns = showRes && k === L;
      return `<button type="button" class="bub${on ? ' on' : ''}${isAns ? ' ans' : ''}" data-q="${q}" data-o="${L}" aria-pressed="${on}" aria-label="Question ${q}, option ${L}"${locked ? ' disabled' : ''}>${L}</button>`;
    }).join('');
    const flag = isKey ? '' :
      `<button type="button" class="flag${isRev ? ' on' : ''}" data-r="${q}" aria-label="Mark question ${q} for review" aria-pressed="${isRev}">⚑</button>`;
    return `<div class="row ${cls}${isRev && !isKey ? ' rev' : ''}" id="q${q}"><div class="qn">${q}</div><div class="opts">${bubs}</div>${flag}</div>`;
  }

  function renderSheet() {
    const isKey = S.tab === 'key';
    const b = bucket();
    const locked = S.submitted && !isKey;
    const ans = countOf(S.answers);
    const keyN = countOf(S.key);
    const revN = Object.keys(S.review).filter((q) => +q <= S.n).length;
    const cur = isKey ? keyN : ans;
    const pct = S.n ? (cur / S.n) * 100 : 0;

    $('#mockChip').textContent = '📝 ' + activeMock().name;
    $('#pBar').style.width = pct + '%';
    $('#pPct').textContent = Math.round(pct) + '%';
    $('#pText').textContent = isKey
      ? `Answer key filled ${keyN}/${S.n}`
      : `Answered ${ans}/${S.n} · Pending ${S.n - ans} · ⚑ ${revN}`;

    const hint = $('#hint');
    if (isKey) {
      hint.hidden = false;
      hint.textContent = '🔑 Answer Key mode – tap the CORRECT option for each question. Tap again to remove.';
    } else if (S.submitted) {
      hint.hidden = false;
      hint.textContent = '✅ Submitted. Green = correct, red = wrong. Open the Result tab for details.';
    } else {
      hint.hidden = true;
    }

    $$('#filters .chip').forEach((c) => c.classList.toggle('on', c.dataset.f === S.filter));

    let html = '';
    for (let q = 1; q <= S.n; q++) {
      const val = b[q];
      const isRev = !!S.review[q];
      if (S.filter === 'todo' && val) continue;
      if (S.filter === 'review' && (!isRev || isKey)) continue;
      html += rowHTML(q, val, isRev, isKey, locked);
    }
    $('#list').innerHTML = html || '<p class="empty">No questions match this filter.</p>';

    $('#submitBtn').innerHTML = isKey ? '<span aria-hidden="true">📊</span><span>Result</span>' : '✅<span>Submit</span>';
    $('#submitBtn').dataset.act = isKey ? 'viewResult' : 'submit';
    $('#submitBtn').disabled = S.submitted && !isKey;
    $$('#actionbar [data-act="clear"], #actionbar [data-act="bulk"]').forEach((x) => { x.disabled = locked; });
  }

  /* ---------- charts (inline SVG, no libraries) ---------- */
  const STATUS_COLOR = { correct: 'var(--ok)', wrong: 'var(--bad)', skipped: 'var(--skip)', nokey: 'var(--warn)' };

  function timeChartSVG(rows) {
    const n = rows.length;
    const t = rows.map((x) => S.qtime[x.q] || 0);
    const max = Math.max(1, ...t);
    const bw = 10, gap = 4, H = 110;
    const W = 8 + n * (bw + gap);
    let bars = '';
    rows.forEach((x, i) => {
      const h = Math.max(t[i] > 0 ? 2 : 0, (t[i] / max) * H);
      const xp = 4 + i * (bw + gap);
      bars += `<rect x="${xp}" y="${H - h}" width="${bw}" height="${h}" rx="2" fill="${STATUS_COLOR[x.st]}"><title>Q${x.q}: ${fmt(t[i])}</title></rect>`;
      if (x.q === 1 || x.q % 5 === 0) bars += `<text x="${xp + bw / 2}" y="${H + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">${x.q}</text>`;
    });
    return `<div class="chart-scroll"><svg viewBox="0 0 ${W} ${H + 20}" style="width:100%;min-width:${Math.min(W, 1400)}px;height:auto" role="img" aria-label="Time spent per question">${bars}</svg></div>`;
  }

  function scoreChartSVG(items) {
    const H = 110, bw = 40, gap = 20, pad = 10;
    const W = pad * 2 + items.length * (bw + gap);
    let s = '';
    items.forEach((it, i) => {
      const h = Math.max(3, (it.pct / 100) * H);
      const x = pad + i * (bw + gap);
      s += `<rect x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="6" fill="url(#gBar)"><title>${esc(it.name)}: ${fmtNum(it.s)}</title></rect>`;
      s += `<text x="${x + bw / 2}" y="${H + 16}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink)">${esc(fmtNum(it.s))}</text>`;
      s += `<text x="${x + bw / 2}" y="${H + 31}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(it.name.slice(0, 9))}</text>`;
    });
    return `<div class="chart-scroll"><svg viewBox="0 0 ${W} ${H + 38}" style="width:100%;min-width:${Math.min(W, 520)}px;height:auto" role="img" aria-label="Score per mock">
      <defs><linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>${s}</svg></div>`;
  }

  /* ---------- rendering: results ---------- */
  function renderResults() {
    const r = computeScore(S);
    const pct = Math.max(0, Math.min(100, r.pct));
    const view = $('#resultsView');
    const status = S.submitted ? '✅ Submitted' : '🟡 Live preview (not submitted)';
    const elapsed = S.startedAt ? (S.submittedAt || Date.now()) - S.startedAt : 0;
    const nkWarn = r.nk
      ? `<div class="warn-box">⚠️ ${r.nk} answered question(s) have no answer key yet – they are not scored. Fill the <b>Answer Key</b> tab.</div>`
      : '';
    const noKeyWarn = r.keyFilled === 0
      ? `<div class="warn-box">🔑 Answer key is empty. Go to <b>Answer Key</b> tab and fill it (or use Paste) to get marks.</div>`
      : '';

    // time analytics
    const totalQ = r.rows.reduce((a, x) => a + (S.qtime[x.q] || 0), 0);
    const answeredRows = r.rows.filter((x) => x.a);
    const timed = r.rows.filter((x) => (S.qtime[x.q] || 0) > 0);
    const slow = timed.length ? timed.reduce((a, b) => ((S.qtime[b.q] || 0) > (S.qtime[a.q] || 0) ? b : a)) : null;
    const avgQ = timed.length ? totalQ / timed.length : 0;
    const timeNote = totalQ === 0
      ? '<p class="muted">Question time abhi track nahi hua. Jab aap question par tap karoge, time apne aap record hoga.</p>'
      : '';

    const rows = r.rows.map((x) => {
      const mk = markOf(x.st);
      const mks = x.st === 'nokey' || x.st === 'skipped' ? '0' : (mk > 0 ? '+' : '') + fmtNum(mk);
      return `<div class="qrow ${x.st}"><span>Q${x.q}</span><span>${x.a || '—'}</span><span>${x.k || '—'}</span><span class="st">${labelOf(x.st)}</span><span>${mks}</span><span class="tm">${S.qtime[x.q] ? fmt(S.qtime[x.q]) : '—'}</span></div>`;
    }).join('');

    view.innerHTML = `
      <div class="card hero">
        <div class="ring" style="--p:${pct.toFixed(2)}"><div><b>${fmtNum(r.s)}</b><small>of ${fmtNum(r.max)}</small></div></div>
        <div>
          <h2>${esc(S.name || 'Candidate')}</h2>
          <p>Roll: ${esc(S.roll || '—')} · ${esc(activeMock().name)} · ${esc(S.title || 'Test')}</p>
          <span class="badge">${status}</span>
          <p>${pct.toFixed(1)}% score · Accuracy ${r.acc}% · ⏱ ${fmt(elapsed)}</p>
        </div>
      </div>
      ${noKeyWarn}${nkWarn}
      <div class="stats">
        <div class="stat ok"><b>${r.c}</b><small>Correct</small></div>
        <div class="stat bad"><b>${r.w}</b><small>Wrong</small></div>
        <div class="stat skip"><b>${r.u}</b><small>Skipped</small></div>
        <div class="stat"><b>${r.nk}</b><small>No key</small></div>
        <div class="stat"><b>${r.acc}%</b><small>Accuracy</small></div>
        <div class="stat"><b>${fmt(totalQ)}</b><small>Question time</small></div>
      </div>
      <div class="card">
        <h3>Breakdown</h3>
        <div class="stack">
          <span class="ok" style="width:${(r.c / S.n) * 100}%"></span>
          <span class="bad" style="width:${(r.w / S.n) * 100}%"></span>
          <span class="nk" style="width:${(r.nk / S.n) * 100}%"></span>
          <span class="skip" style="width:${(r.u / S.n) * 100}%"></span>
        </div>
        <div class="legend">
          <span><i style="background:var(--ok)"></i>Correct ${r.c}</span>
          <span><i style="background:var(--bad)"></i>Wrong ${r.w}</span>
          <span><i style="background:var(--warn)"></i>No key ${r.nk}</span>
          <span><i style="background:var(--skip)"></i>Skipped ${r.u}</span>
        </div>
      </div>
      <div class="card">
        <h3>Time per question</h3>
        ${timeNote}
        ${timeChartSVG(r.rows)}
        <div class="legend">
          <span><i style="background:var(--ok)"></i>Correct</span>
          <span><i style="background:var(--bad)"></i>Wrong</span>
          <span><i style="background:var(--skip)"></i>Skipped</span>
        </div>
        <div class="time-stats">
          <span>Avg / question: <b>${fmt(avgQ)}</b></span>
          <span>Slowest: <b>${slow ? `Q${slow.q} (${fmt(S.qtime[slow.q])})` : '—'}</b></span>
          <span>Answered: <b>${answeredRows.length}</b></span>
        </div>
      </div>
      <div class="card">
        <h3>Question-wise</h3>
        <div class="qtable">
          <div class="qrow head"><span>Q</span><span>You</span><span>Key</span><span>Result</span><span>Marks</span><span>Time</span></div>
          ${rows}
        </div>
      </div>
      <div class="actions">
        <button class="btn" data-act="csv">⬇️ Export CSV</button>
        <button class="btn" data-act="share">📤 Share</button>
        <button class="btn" data-act="print">🖨️ Print / PDF</button>
        ${S.submitted
          ? '<button class="btn" data-act="reopen">✏️ Re-open sheet</button>'
          : '<button class="btn" data-act="goSheet">↩ Back to sheet</button>'}
      </div>`;
  }

  /* ---------- rendering: mocks ---------- */
  function renderMocks() {
    const withAns = store.mocks.filter((m) => countOf(m.data.answers, m.data.n) > 0 || m.data.submitted);
    const chartItems = withAns.map((m) => {
      const r = computeScore(m.data);
      return { name: m.name, s: r.s, pct: Math.max(0, Math.min(100, r.pct)) };
    });
    const chart = chartItems.length
      ? `<div class="card"><h3>Score per mock</h3>${scoreChartSVG(chartItems)}</div>`
      : '';

    const cards = store.mocks.map((m) => {
      const d = m.data;
      const r = computeScore(d);
      const st = d.submitted ? '✅ Submitted' : d.startedAt ? '⏳ In progress' : '○ Not started';
      const active = m.id === store.activeId;
      const dt = new Date(m.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      return `
        <div class="mock-card${active ? ' active' : ''}">
          <div class="mock-main">
            <div class="mock-name">${esc(m.name)}${active ? ' <span class="tag">Open</span>' : ''}</div>
            <div class="muted">${st} · ${dt} · ${countOf(d.answers, d.n)}/${d.n} answered</div>
            <div class="mock-score">Score <b>${fmtNum(r.s)}</b> / ${fmtNum(r.max)} · Acc ${r.acc}%</div>
          </div>
          <div class="mock-btns">
            ${active ? '' : `<button class="btn small" data-act="openMock" data-id="${m.id}">Open</button>`}
            <button class="btn small" data-act="renameMock" data-id="${m.id}">Rename</button>
            <button class="btn small danger" data-act="deleteMock" data-id="${m.id}">Delete</button>
          </div>
        </div>`;
    }).join('');

    $('#mocksView').innerHTML = `
      <div class="mock-head">
        <div>
          <h2>My Mocks</h2>
          <p class="muted">Har mock alag save hota hai. Naya mock banane se purana data safe rahega.</p>
        </div>
        <button class="btn primary" data-act="newMock">＋ New mock</button>
      </div>
      ${chart}
      <div class="section-title">All mocks (${store.mocks.length})</div>
      <div class="mock-list">${cards}</div>`;
  }

  function renderTabs() {
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === S.tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
    });
    const sheet = S.tab === 'sheet' || S.tab === 'key';
    $('#sheetView').hidden = !sheet;
    $('#resultsView').hidden = S.tab !== 'results';
    $('#mocksView').hidden = S.tab !== 'mocks';
    $('#actionbar').hidden = !sheet;
  }

  function renderSetupValues() {
    $('#cfgSummary').textContent = `${S.n} Q · ${S.opts === 5 ? 'A–E' : 'A–D'} · +${S.plus} / −${S.minus}${S.timerMin ? ' · ' + S.timerMin + ' min' : ''}`;
    $('#fName').value = S.name;
    $('#fRoll').value = S.roll;
    $('#fTitle').value = S.title;
    $('#fN').value = S.n;
    $('#fOpts').value = String(S.opts);
    $('#fPlus').value = S.plus;
    $('#fMinus').value = S.minus;
    $('#fTimer').value = S.timerMin;
    $('#swTheme').checked = S.theme === 'dark';
    $('#swSound').checked = S.sound;
    $('#swHaptic').checked = S.haptics;
    $('#swNext').checked = S.autoNext;
    $('#swInstant').checked = !!S.instant;
  }

  function renderAll() {
    applyTheme();
    renderTabs();
    if (S.tab === 'results') renderResults();
    else if (S.tab === 'mocks') renderMocks();
    else renderSheet();
    tick();
  }

  /* ---------- timer ---------- */
  const elapsedMs = () => (S.startedAt ? (S.submittedAt || Date.now()) - S.startedAt : 0);

  function startTick() {
    if (tickId) return;
    tickId = setInterval(tick, 1000);
  }
  function stopTick() {
    clearInterval(tickId);
    tickId = null;
  }
  function tick() {
    const el = $('#clock');
    if (!S.startedAt) { el.textContent = '00:00'; el.classList.remove('warn'); stopTick(); return; }
    if (S.submitted) { el.textContent = '✔ ' + fmt(elapsedMs()); el.classList.remove('warn'); stopTick(); return; }
    startTick();
    if (S.timerMin > 0) {
      const rem = S.timerMin * 60000 - elapsedMs();
      if (rem <= 0) {
        el.textContent = '00:00';
        submit(true);
        return;
      }
      el.textContent = '⏳ ' + fmt(rem);
      el.classList.toggle('warn', rem < 60000);
    } else {
      el.textContent = '⏱ ' + fmt(elapsedMs());
      el.classList.remove('warn');
    }
  }

  /* ---------- submit / reopen / reset ---------- */
  function submit(auto = false) {
    if (S.submitted) return;
    if (!auto && countOf(S.answers) === 0) return toast('Fill some answers first');
    if (!auto && !confirm('Submit the answer sheet? You can re-open it later from the Result tab.')) return;
    flushQ();
    if (auto) toast('⏰ Time is up – sheet auto-submitted');
    S.submitted = true;
    S.submittedAt = Date.now();
    S.tab = 'results';
    save();
    renderAll();
    if (!auto) toast('Submitted ✅');
  }

  function reopen() {
    S.submitted = false;
    S.submittedAt = null;
    S.tab = 'sheet';
    save();
    renderAll();
    toast('Sheet re-opened for editing');
  }

  function resetMock() {
    if (!confirm(`"${activeMock().name}" ka answers, key aur time clear karna hai? Mock ka naam aur settings rahenge.`)) return;
    const keep = {};
    ['name', 'roll', 'title', 'n', 'opts', 'plus', 'minus', 'timerMin', ...SETTINGS].forEach((k) => { keep[k] = S[k]; });
    undoStack.length = 0;
    curQ = null;
    stopTick();
    S = Object.assign(defaults(), keep);
    save();
    renderSetupValues();
    renderAll();
    toast('Mock reset');
  }

  function clearCurrent() {
    if (S.submitted && S.tab === 'sheet') return;
    const label = S.tab === 'key' ? 'answer key' : 'answers';
    if (!confirm(`Clear all ${label}?`)) return;
    pushUndo();
    if (S.tab === 'key') S.key = {};
    else { S.answers = {}; S.review = {}; S.qtime = {}; }
    save();
    renderAll();
    toast('Cleared – Undo available');
  }

  /* ---------- multiple mocks ---------- */
  function switchMock(id) {
    const m = store.mocks.find((x) => x.id === id);
    if (!m) return;
    flushQ();
    save();
    const keep = {};
    SETTINGS.forEach((k) => { keep[k] = S[k]; });
    S = Object.assign(defaults(), m.data, keep);
    S.tab = 'sheet';
    store.activeId = id;
    undoStack.length = 0;
    curQ = null;
    save();
    stopTick();
    renderSetupValues();
    renderAll();
    if (S.startedAt && !S.submitted) startTick();
  }

  function nextMockName() {
    let max = 0;
    store.mocks.forEach((m) => {
      const mm = /^Mock\s+(\d+)$/i.exec(m.name);
      if (mm) max = Math.max(max, +mm[1]);
    });
    return `Mock ${max + 1 || store.mocks.length + 1}`;
  }

  function newMock() {
    const id = newId();
    const name = nextMockName();
    const base = Object.assign(defaults(), {
      n: S.n, opts: S.opts, plus: S.plus, minus: S.minus, timerMin: S.timerMin,
      name: S.name, roll: S.roll, title: S.title, tab: 'sheet',
    });
    store.mocks.push({ id, name, createdAt: Date.now(), data: base });
    switchMock(id);
    toast(`${name} created`);
  }

  function renameMock(id) {
    const m = store.mocks.find((x) => x.id === id);
    if (!m) return;
    const v = prompt('Mock ka naam', m.name);
    if (v === null) return;
    const name = v.trim().slice(0, 30);
    if (!name) return toast('Naam khali nahi ho sakta');
    m.name = name;
    save();
    renderAll();
  }

  function deleteMock(id) {
    const m = store.mocks.find((x) => x.id === id);
    if (!m) return;
    if (!confirm(`"${m.name}" delete karna hai? Ye wapas nahi aayega.`)) return;
    const wasActive = store.activeId === id;
    store.mocks = store.mocks.filter((x) => x.id !== id);
    if (!store.mocks.length) {
      store.mocks.push({ id: newId(), name: 'Mock 1', createdAt: Date.now(), data: defaults() });
    }
    if (wasActive) {
      store.activeId = null;
      switchMock(store.mocks[0].id);
    } else {
      save();
      renderAll();
    }
    toast(`${m.name} deleted`);
  }

  /* ---------- bulk paste ---------- */
  function parseBulk(text) {
    const t = String(text || '').toUpperCase();
    const out = {};
    const pairRe = /(\d{1,3})\s*[-.:=)\]]?\s*([A-E])(?![A-Z])/g;
    let m;
    let pairs = 0;
    while ((m = pairRe.exec(t))) {
      out[+m[1]] = m[2];
      pairs++;
    }
    if (!pairs) {
      const letters = t.replace(/[^A-E]/g, '');
      for (let i = 0; i < letters.length; i++) out[i + 1] = letters[i];
    }
    return out;
  }

  function openBulk() {
    if (S.submitted && S.tab === 'sheet') return toast('Sheet is submitted.');
    $('#bulkText').value = '';
    $('#bulk').showModal();
    setTimeout(() => $('#bulkText').focus(), 50);
  }
  function applyBulk() {
    const parsed = parseBulk($('#bulkText').value);
    const ok = validLetters();
    const b = bucket();
    let n = 0;
    pushUndo();
    for (const q of Object.keys(parsed)) {
      const qq = +q;
      if (qq >= 1 && qq <= S.n && ok.includes(parsed[q])) { b[qq] = parsed[q]; n++; }
    }
    $('#bulk').close();
    if (S.tab === 'sheet' && !S.startedAt && countOf(S.answers) > 0) S.startedAt = Date.now();
    save();
    renderAll();
    toast(n ? `Filled ${n} question(s)` : 'No valid answers found');
  }

  /* ---------- CSV / share / print ---------- */
  function exportCSV() {
    const r = computeScore(S);
    const meta = [['Mock', activeMock().name], ['Name', S.name], ['Roll', S.roll], ['Test', S.title],
      ['Score', r.s], ['Max', r.max], ['Correct', r.c], ['Wrong', r.w], ['Skipped', r.u]];
    const head = [['Question', 'Your Answer', 'Answer Key', 'Result', 'Marks', 'Time (sec)']];
    const body = r.rows.map((x) => [x.q, x.a, x.k, labelOf(x.st), markOf(x.st), Math.round((S.qtime[x.q] || 0) / 1000)]);
    const csv = [...meta, [], ...head, ...body]
      .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omr-${activeMock().name.replace(/[^\w-]+/g, '_')}-${(S.roll || 'result').replace(/[^\w-]+/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('CSV downloaded');
  }

  async function shareResult() {
    const r = computeScore(S);
    const text = `${S.title} – ${activeMock().name} – ${S.name || 'Candidate'} (${S.roll || '-'})\nScore: ${fmtNum(r.s)}/${fmtNum(r.max)} (${r.pct.toFixed(1)}%)\nCorrect ${r.c} | Wrong ${r.w} | Skipped ${r.u} | Accuracy ${r.acc}%`;
    if (navigator.share) {
      try { await navigator.share({ title: 'OMR Result', text }); } catch (e) { /* cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(text); toast('Result copied to clipboard'); }
      catch (e) { toast('Sharing not supported here'); }
    }
  }

  /* ---------- events ---------- */
  function bindSetup() {
    $('#fName').addEventListener('input', (e) => { S.name = e.target.value.slice(0, 40); save(); });
    $('#fRoll').addEventListener('input', (e) => { S.roll = e.target.value.slice(0, 20); save(); });
    $('#fTitle').addEventListener('input', (e) => { S.title = e.target.value.slice(0, 60); save(); });
    $('#fN').addEventListener('change', (e) => {
      S.n = Math.round(clamp(e.target.value, 1, 200, 50));
      prune(); save(); renderSetupValues(); renderAll();
    });
    $('#fOpts').addEventListener('change', (e) => {
      S.opts = +e.target.value === 5 ? 5 : 4;
      prune(); save(); renderAll();
    });
    $('#fPlus').addEventListener('change', (e) => { S.plus = clamp(e.target.value, 0, 10, 4); save(); renderSetupValues(); renderAll(); });
    $('#fMinus').addEventListener('change', (e) => { S.minus = clamp(e.target.value, 0, 10, 1); save(); renderSetupValues(); renderAll(); });
    $('#fTimer').addEventListener('change', (e) => {
      S.timerMin = Math.round(clamp(e.target.value, 0, 600, 0));
      save(); renderSetupValues(); tick();
    });

    $('#swTheme').addEventListener('change', (e) => { S.theme = e.target.checked ? 'dark' : 'light'; save(); applyTheme(); });
    $('#swSound').addEventListener('change', (e) => { S.sound = e.target.checked; save(); if (S.sound) beep(); });
    $('#swHaptic').addEventListener('change', (e) => { S.haptics = e.target.checked; save(); buzz(20); });
    $('#swNext').addEventListener('change', (e) => { S.autoNext = e.target.checked; save(); });
    $('#swInstant').addEventListener('change', (e) => {
      S.instant = e.target.checked; save(); renderSheet();
      toast(S.instant ? 'Instant check ON – answers turant check honge' : 'Instant check OFF');
    });
  }

  function bind() {
    bindSetup();

    // Tabs
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      flushQ();
      S.tab = t.dataset.tab;
      if (S.tab === 'key') S.filter = 'all';
      save();
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));

    // Filters
    $$('#filters .chip').forEach((c) => c.addEventListener('click', () => {
      S.filter = c.dataset.f; save(); renderSheet();
    }));

    // Jump to question
    const jump = () => {
      const q = parseInt($('#goto').value, 10);
      if (!q || q < 1 || q > S.n) return toast(`Enter 1 – ${S.n}`);
      if (S.filter !== 'all') { S.filter = 'all'; save(); renderSheet(); }
      scrollToQ(q, true);
      $('#goto').value = '';
      $('#goto').blur();
    };
    $('#goto').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(); } });
    $('#goto').addEventListener('change', jump);

    // Bubble + flag taps (event delegation)
    $('#list').addEventListener('click', (e) => {
      const bub = e.target.closest('.bub');
      if (bub && !bub.disabled) return fill(+bub.dataset.q, bub.dataset.o);
      const flag = e.target.closest('.flag');
      if (flag) return toggleReview(+flag.dataset.r);
    });

    // Generic actions
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      switch (el.dataset.act) {
        case 'undo': return undo();
        case 'clear': return clearCurrent();
        case 'bulk': return openBulk();
        case 'bulkApply': return applyBulk();
        case 'bulkCancel': return $('#bulk').close();
        case 'submit': return submit(false);
        case 'viewResult': flushQ(); S.tab = 'results'; save(); return renderAll();
        case 'goSheet': S.tab = 'sheet'; save(); return renderAll();
        case 'reopen': return reopen();
        case 'reset': return resetMock();
        case 'csv': return exportCSV();
        case 'share': return shareResult();
        case 'print': return window.print();
        case 'install': return installApp();
        case 'newMock': return newMock();
        case 'openMock': S.tab = 'sheet'; save(); return switchMock(el.dataset.id);
        case 'renameMock': return renameMock(el.dataset.id);
        case 'deleteMock': return deleteMock(el.dataset.id);
      }
    });

    // Keep the result view fresh while the timer runs
    setInterval(() => { if (S.tab === 'results' && !S.submitted) renderResults(); }, 5000);

    // Save time spent when the app goes to background
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { flushQ(); save(); }
    });

    // PWA install prompt (Android Chrome)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      $('#installBtn').hidden = false;
    });
    window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; deferredPrompt = null; });

    // Warn before leaving mid-sheet
    window.addEventListener('beforeunload', (e) => {
      if (!S.submitted && countOf(S.answers) > 0) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  async function installApp() {
    if (!deferredPrompt) return toast('Use Chrome menu → Install app');
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBtn').hidden = true;
  }

  function registerSW() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  }

  function init() {
    prune();
    save(); // persists migrated v1 data (or fresh v2 store) right away
    bind();
    renderSetupValues();
    renderAll();
    if (S.startedAt && !S.submitted) startTick();
    registerSW();
  }

  init();
})();

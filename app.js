/* OMR Fill – app logic (vanilla JS, no dependencies) */
(() => {
  'use strict';

  const STORE_KEY = 'omrfill:v1';
  const LETTERS = ['A', 'B', 'C', 'D', 'E'];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, min, max, d) => {
    const x = parseFloat(v);
    return Number.isNaN(x) ? d : Math.min(max, Math.max(min, x));
  };

  const defaults = () => ({
    name: '', roll: '', title: 'Mock Test',
    n: 50, opts: 4, plus: 4, minus: 1, timerMin: 0,
    theme: 'dark', sound: true, haptics: true, autoNext: true,
    tab: 'sheet', filter: 'all',
    answers: {}, key: {}, review: {},
    startedAt: null, submittedAt: null, submitted: false,
  });

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign(defaults(), JSON.parse(raw));
    } catch (e) { /* corrupted storage – fall back to defaults */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* storage full / disabled */ }
  }

  let S = load();
  const undoStack = [];
  let deferredPrompt = null;
  let tickId = null;

  /* ---------- helpers ---------- */
  const validLetters = () => LETTERS.slice(0, S.opts);
  const bucket = () => (S.tab === 'key' ? S.key : S.answers);
  const countOf = (obj) => Object.keys(obj).filter((q) => +q >= 1 && +q <= S.n && obj[q]).length;

  function prune() {
    const ok = validLetters();
    for (const obj of [S.answers, S.key]) {
      for (const q of Object.keys(obj)) {
        if (+q > S.n || +q < 1 || !ok.includes(obj[q])) delete obj[q];
      }
    }
    for (const q of Object.keys(S.review)) if (+q > S.n || +q < 1) delete S.review[q];
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

  /* ---------- scoring ---------- */
  function computeScore() {
    let c = 0, w = 0, u = 0, nk = 0;
    const rows = [];
    for (let q = 1; q <= S.n; q++) {
      const a = S.answers[q] || '';
      const k = S.key[q] || '';
      let st;
      if (!a) { u++; st = 'skipped'; }
      else if (!k) { nk++; st = 'nokey'; }
      else if (a === k) { c++; st = 'correct'; }
      else { w++; st = 'wrong'; }
      rows.push({ q, a, k, st });
    }
    const s = c * S.plus - w * S.minus;
    const max = S.n * S.plus;
    const pct = max > 0 ? (s / max) * 100 : 0;
    const acc = c + w > 0 ? Math.round((c / (c + w)) * 100) : 0;
    return { c, w, u, nk, s, max, pct, acc, rows, keyFilled: countOf(S.key) };
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

  /* ---------- rendering ---------- */
  function applyTheme() {
    document.documentElement.dataset.theme = S.theme;
    const meta = $('#themeMeta');
    if (meta) meta.setAttribute('content', S.theme === 'light' ? '#f3f5fb' : '#0b1020');
  }

  function rowHTML(q, val, isRev, isKey, locked) {
    const showRes = S.submitted && !isKey;
    const k = showRes ? S.key[q] : undefined;
    let cls = '';
    if (showRes && k) cls = !val ? 'skip' : val === k ? 'right' : 'wrong';
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
    $('#actionbar').hidden = false;
  }

  function renderResults() {
    const r = computeScore();
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
    const denom = Math.max(1, S.n);
    const rows = r.rows.map((x) => {
      const mk = markOf(x.st);
      return `<div class="qrow ${x.st}"><span>Q${x.q}</span><span>${x.a || '—'}</span><span>${x.k || '—'}</span><span class="st">${labelOf(x.st)}</span><span>${x.st === 'nokey' || x.st === 'skipped' ? '0' : (mk > 0 ? '+' : '') + fmtNum(mk)}</span></div>`;
    }).join('');

    view.innerHTML = `
      <div class="card hero">
        <div class="ring" style="--p:${pct.toFixed(2)}"><div><b>${fmtNum(r.s)}</b><small>of ${fmtNum(r.max)}</small></div></div>
        <div>
          <h2>${esc(S.name || 'Candidate')}</h2>
          <p>Roll: ${esc(S.roll || '—')} · ${esc(S.title || 'Test')}</p>
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
        <div class="stat"><b>${S.n}</b><small>Questions</small></div>
      </div>
      <div class="card">
        <h3>Breakdown</h3>
        <div class="stack">
          <span class="ok" style="width:${(r.c / denom) * 100}%"></span>
          <span class="bad" style="width:${(r.w / denom) * 100}%"></span>
          <span class="nk" style="width:${(r.nk / denom) * 100}%"></span>
          <span class="skip" style="width:${(r.u / denom) * 100}%"></span>
        </div>
        <div class="legend">
          <span><i style="background:var(--ok)"></i>Correct ${r.c}</span>
          <span><i style="background:var(--bad)"></i>Wrong ${r.w}</span>
          <span><i style="background:var(--warn)"></i>No key ${r.nk}</span>
          <span><i style="background:var(--skip)"></i>Skipped ${r.u}</span>
        </div>
      </div>
      <div class="card">
        <h3>Question-wise</h3>
        <div class="qtable">
          <div class="qrow head"><span>Q</span><span>You</span><span>Key</span><span>Result</span><span>Marks</span></div>
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

  function renderTabs() {
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === S.tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
    });
    const isRes = S.tab === 'results';
    $('#sheetView').hidden = isRes;
    $('#resultsView').hidden = !isRes;
    $('#actionbar').hidden = isRes;
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
  }

  function renderAll() {
    applyTheme();
    renderTabs();
    if (S.tab === 'results') renderResults();
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

  function resetAll() {
    if (!confirm('Reset everything? All answers, key and timer will be cleared.')) return;
    S = Object.assign(defaults(), { theme: S.theme, sound: S.sound, haptics: S.haptics, autoNext: S.autoNext });
    undoStack.length = 0;
    stopTick();
    save();
    renderSetupValues();
    renderAll();
    toast('Reset done');
  }

  function clearCurrent() {
    if (S.submitted && S.tab === 'sheet') return;
    const label = S.tab === 'key' ? 'answer key' : 'answers';
    if (!confirm(`Clear all ${label}?`)) return;
    pushUndo();
    if (S.tab === 'key') S.key = {};
    else { S.answers = {}; S.review = {}; }
    save();
    renderAll();
    toast('Cleared – Undo available');
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
    save();
    if (S.tab === 'sheet' && !S.startedAt && countOf(S.answers) > 0) { S.startedAt = Date.now(); save(); }
    renderAll();
    toast(n ? `Filled ${n} question(s)` : 'No valid answers found');
  }

  /* ---------- CSV / share / print ---------- */
  function exportCSV() {
    const r = computeScore();
    const meta = [['Name', S.name], ['Roll', S.roll], ['Test', S.title], ['Score', r.s], ['Max', r.max], ['Correct', r.c], ['Wrong', r.w], ['Skipped', r.u]];
    const head = [['Question', 'Your Answer', 'Answer Key', 'Result', 'Marks']];
    const body = r.rows.map((x) => [x.q, x.a, x.k, labelOf(x.st), markOf(x.st)]);
    const csv = [...meta, [], ...head, ...body]
      .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omr-${(S.roll || 'result').replace(/[^\w-]+/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('CSV downloaded');
  }

  async function shareResult() {
    const r = computeScore();
    const text = `${S.title} – ${S.name || 'Candidate'} (${S.roll || '-'})\nScore: ${fmtNum(r.s)}/${fmtNum(r.max)} (${r.pct.toFixed(1)}%)\nCorrect ${r.c} | Wrong ${r.w} | Skipped ${r.u} | Accuracy ${r.acc}%`;
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
  }

  function bind() {
    bindSetup();

    // Tabs
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
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
        case 'viewResult': S.tab = 'results'; save(); return renderAll();
        case 'goSheet': S.tab = 'sheet'; save(); return renderAll();
        case 'reopen': return reopen();
        case 'reset': return resetAll();
        case 'csv': return exportCSV();
        case 'share': return shareResult();
        case 'print': return window.print();
        case 'install': return installApp();
      }
    });

    // Keep the result view fresh when the timer ticks on it
    setInterval(() => { if (S.tab === 'results' && !S.submitted) renderResults(); }, 5000);

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
    bind();
    renderSetupValues();
    renderAll();
    if (S.startedAt && !S.submitted) startTick();
    registerSW();
  }

  init();
})();

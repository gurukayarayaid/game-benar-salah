/* ══════════ Game Tarik Tambang — logika permainan ══════════
 *
 * Aturan:
 *  - Dua tim (Biru kiri, Merah kanan) menjawab soal pilihan ganda A–D secara
 *    bergantian di satu layar sentuh (PID).
 *  - Jawaban BENAR  → SIMPUL TALI LAWAN tertarik 1 langkah ke arah garis tengah.
 *  - Jawaban SALAH / waktu habis → tidak ada tarikan, giliran berpindah.
 *  - Simpul tali setiap tim mulai 5 langkah dari garis tengah. Jika simpul tim
 *    itu sudah MENYENTUH GARIS TENGAH (tertarik 5 kali), tim itu kalah.
 *
 * Bank soal: www/game/questions-tt.json (pilihan ganda), format:
 *   { t: teks soal, o: [opsi A-D], a: indeks jawaban benar, e: penjelasan }
 */
(function () {
  'use strict';

  /* ── Konstanta aturan ── */
  const WIN_STEPS = 5;          // 5 langkah dari garis tengah sampai menyentuh
  const PULL_ANIM_MS = 900;     // lama animasi tarik + jeda feedback

  /* ── Status permainan ── */
  const S = {
    subject: 'mtk',
    level: 'mudah',
    nameA: 'Tim Biru',
    nameB: 'Tim Merah',
    rot: 1,             // soal per giliran
    aiLevel: 0,         // 0 = dua tim manusia; 0..1 = peluang benar komputer
    timerSec: 20,
    pool: [],           // soal yang tersisa
    used: 0,            // jumlah soal yang sudah dimainkan
    turn: 'A',          // 'A' | 'B'
    turnsInRound: 0,    // penghitung rotasi
    pos: 0,             // posisi simpul Tim Biru: 0..WIN_STEPS (0 = penuh; WIN_STEPS = menyentuh tengah)
    posB: 0,            // posisi simpul Tim Merah: 0..WIN_STEPS
    pullsA: 0,          // tarikan yang berhasil dilakukan Tim Biru
    pullsB: 0,
    scoreA: 0, scoreB: 0, draw: 0,
    locked: false,      // sedang menunggu animasi/feedback
    over: false,
    timerId: null,
    timeLeft: 0,
    sound: true,
  };

  /* ── Ambil elemen ── */
  const $ = id => document.getElementById(id);
  const el = {
    // menu
    screenMenu: $('screenMenu'), screenPlay: $('screenPlay'), screenResult: $('screenResult'),
    selSubject: $('selSubject'), selLevel: $('selLevel'),
    inpNameA: $('inpNameA'), inpNameB: $('inpNameB'),
    selRot: $('selRot'), selAI: $('selAI'), selTimer: $('selTimer'),
    btnStart: $('btnStart'), btnFull: $('btnFull'), btnFull2: $('btnFull2'),
    sourceBadge: $('sourceBadge'), poolInfo: $('poolInfo'),
    // bermain
    chipSubject: $('chipSubject'), chipProgress: $('chipProgress'), chipTurn: $('chipTurn'),
    btnSound: $('btnSound'), btnQuit: $('btnQuit'),
    timerChip: $('timerChip'), timerBar: $('timerBar'), timerText: $('timerText'),
    turnName: $('turnName'), questionText: $('questionText'), optWrap: $('optWrap'),
    teamA: $('teamA'), teamB: $('teamB'), labelA: $('labelA'), labelB: $('labelB'),
    countA: $('countA'), countB: $('countB'),
    marker: $('marker'), arena: $('arena'),
    knotA: $('knotA'), knotB: $('knotB'),
    ropePath: $('ropePath'), ropeSvg: $('ropeSvg'),
    critterA: $('critterA'), critterB: $('critterB'),
    dangerLeft: $('dangerLeft'), dangerRight: $('dangerRight'),
    feedback: $('feedback'), fbHead: $('fbHead'), fbResult: $('fbResult'), fbExplain: $('fbExplain'),
    // hasil
    resultTitle: $('resultTitle'), resultSub: $('resultSub'), trophy: $('trophy'),
    statA: $('statA'), statB: $('statB'), statDraw: $('statDraw'),
    statALabel: $('statALabel'), statBLabel: $('statBLabel'),
    btnAgain: $('btnAgain'), btnBackMenu: $('btnBackMenu'),
    toast: $('toast'),
  };

  /* ── Suara (Web Audio, tanpa berkas) ── */
  let AC = null;
  function beep(freq, dur, type = 'sine', vol = .22, delay = 0) {
    if (!S.sound) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = AC.currentTime + delay;
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
      o.connect(g); g.connect(AC.destination);
      o.start(t0); o.stop(t0 + dur);
    } catch (e) { /* audio tidak tersedia */ }
  }
  const sndCorrect = () => { beep(523, .12, 'triangle'); beep(659, .12, 'triangle', .22, .1); beep(784, .2, 'triangle', .22, .2); };
  const sndWrong = () => { beep(220, .25, 'sawtooth', .14); beep(160, .3, 'sawtooth', .12, .12); };
  const sndPull = () => beep(140, .3, 'square', .1);
  const sndWin = () => { [523, 659, 784, 1047].forEach((f, i) => beep(f, .18, 'triangle', .25, i * .13)); };

  /* ── Util ── */
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  const turnLabel = () => S.turn === 'A' ? S.nameA : S.nameB;

  /* ── Bank soal ── */
  async function loadBank() {
    const r = await fetch('questions-tt.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('Bank soal tidak ditemukan');
    return r.json();
  }

  let BANK = null;
  async function initMenu() {
    try {
      BANK = await loadBank();
      el.selSubject.innerHTML = '';
      for (const s of BANK.subjects) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = `${s.icon} ${s.name}`;
        el.selSubject.appendChild(o);
      }
      el.sourceBadge.textContent = 'Bank bawaan';
      refreshPoolInfo();
    } catch (e) {
      el.sourceBadge.textContent = 'Soal gagal dimuat';
      toast('Gagal memuat bank soal: ' + e.message);
    }
  }

  function refreshPoolInfo() {
    if (!BANK) { el.poolInfo.textContent = ''; return; }
    const sub = BANK.subjects.find(s => s.id === el.selSubject.value);
    const n = ((sub && sub.levels && sub.levels[el.selLevel.value]) || []).length;
    el.poolInfo.textContent = n
      ? `Tersedia ${n} soal pilihan ganda untuk mapel ini.`
      : 'Belum ada soal untuk kombinasi ini — pilih mapel/tingkat lain.';
  }

  /* ── Layar ── */
  function show(screen) {
    for (const s of [el.screenMenu, el.screenPlay, el.screenResult]) s.hidden = (s !== screen);
  }

  /* ── Mulai permainan ── */
  function startGame() {
    if (!BANK) { toast('Bank soal belum siap'); return; }
    const sub = BANK.subjects.find(s => s.id === el.selSubject.value);
    const raw = ((sub && sub.levels && sub.levels[el.selLevel.value]) || []).map(q => ({
      t: q.t, o: q.o.slice(), a: q.a, e: q.e || ''
    }));
    if (!raw.length) { toast('Belum ada soal untuk kombinasi ini'); return; }

    S.subject = sub.name;
    S.level = el.selLevel.value;
    S.nameA = el.inpNameA.value.trim() || 'Tim Biru';
    S.nameB = el.inpNameB.value.trim() || 'Tim Merah';
    S.rot = parseInt(el.selRot.value, 10) || 1;
    S.aiLevel = parseFloat(el.selAI.value) || 0;
    S.timerSec = parseInt(el.selTimer.value, 10) || 0;
    S.pool = shuffle(raw.slice());
    S.allQuestions = raw.slice();
    S.used = 0; S.turn = Math.random() < .5 ? 'A' : 'B';
    S.turnsInRound = 0;
    S.pos = 0; S.posB = 0; S.pullsA = 0; S.pullsB = 0;
    S.scoreA = 0; S.scoreB = 0; S.draw = 0;
    S.locked = false; S.over = false; S.sound = true;
    el.btnSound.textContent = '🔊';

    el.labelA.textContent = S.nameA;
    el.labelB.textContent = S.nameB;
    el.chipSubject.textContent = `${sub.icon || '📘'} ${sub.name} · ${S.level}`;
    show(el.screenPlay);

    if (S.aiLevel > 0) toast(`${S.nameB} dijawab komputer (level ${S.aiLevel >= .8 ? 'sulit' : S.aiLevel >= .55 ? 'sedang' : 'mudah'})`);
    updateTurnUI();
    updateArena(false);
    el.knotA.classList.remove('center-hit');
    el.knotB.classList.remove('center-hit');
    nextQuestion();
  }

  /* ── Ganti giliran ── */
  function nextTurn() {
    S.turnsInRound++;
    if (S.turnsInRound >= S.rot) { S.turnsInRound = 0; S.turn = S.turn === 'A' ? 'B' : 'A'; }
    updateTurnUI();
  }

  function updateTurnUI() {
    el.chipTurn.textContent = `Giliran: ${turnLabel()}`;
    el.turnName.textContent = turnLabel();
    el.teamA.classList.toggle('active', S.turn === 'A');
    el.teamB.classList.toggle('active', S.turn === 'B');
  }

  /* ── Soal ── */
  function nextQuestion() {
    if (!S.pool.length) {
      /* Soal diacak ulang — pertandingan baru selesai saat ada tim yang
         tertarik sampai garis tengah, bukan saat soal habis. */
      S.pool = shuffle(S.allQuestions.slice());
    }
    const q = S.pool.pop();
    S.current = q; S.used++;
    el.chipProgress.textContent = `Soal ${S.used}`;
    el.questionText.textContent = q.t;

    // Acak urutan opsi agar jawaban tidak selalu di posisi sama
    const order = shuffle([0, 1, 2, 3]);
    S.correctIdx = order.indexOf(q.a);
    [...el.optWrap.children].forEach((btn, i) => {
      btn.disabled = false;
      btn.classList.remove('correct', 'wrong');
      btn.querySelector('span').textContent = q.o[order[i]];
    });

    hideFeedback();
    S.locked = false;
    startTimer();
    maybeAI();
  }

  /* ── Timer ── */
  function startTimer() {
    stopTimer();
    if (!S.timerSec) { el.timerChip.hidden = true; return; }
    el.timerChip.hidden = false;
    S.timeLeft = S.timerSec;
    renderTimer();
    S.timerId = setInterval(() => {
      S.timeLeft--;
      renderTimer();
      if (S.timeLeft <= 0) { stopTimer(); onAnswer(-1); }
    }, 1000);
  }
  function stopTimer() {
    if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
  }
  function renderTimer() {
    el.timerText.textContent = S.timeLeft;
    const pct = Math.max(0, S.timeLeft / S.timerSec * 100);
    el.timerBar.style.width = pct + '%';
    el.timerChip.classList.toggle('low', S.timeLeft <= 5);
  }

  /* ── Lawan komputer ── */
  function maybeAI() {
    if (S.aiLevel <= 0 || S.turn !== 'B' || S.over) return;
    const willBeRight = Math.random() < S.aiLevel;
    const delay = 1500 + Math.random() * 2500;
    const idx = willBeRight ? S.correctIdx : pickWrongIdx();
    setTimeout(() => {
      if (S.over || S.locked || S.turn !== 'B') return;
      const btn = el.optWrap.children[idx];
      if (btn) onAnswer(idx, btn);
    }, delay);
  }
  function pickWrongIdx() {
    const wrong = [0, 1, 2, 3].filter(i => i !== S.correctIdx);
    return wrong[Math.floor(Math.random() * wrong.length)];
  }

  /* ── Menjawab ── */
  function onAnswer(idx, btn) {
    if (S.locked || S.over) return;
    S.locked = true;
    stopTimer();
    [...el.optWrap.children].forEach(b => { b.disabled = true; });

    const correct = idx === S.correctIdx;
    if (btn) btn.classList.add(correct ? 'correct' : 'wrong');
    if (!correct && idx >= 0) {
      el.optWrap.children[S.correctIdx].classList.add('correct');
    }

    const who = turnLabel();
    let head, result, explain = S.current.e;

    if (idx < 0) { // waktu habis
      head = '⏰ Waktu habis!';
      result = `${who} tidak menjawab — tali tidak bergerak.`;
      S.draw++;
      sndWrong();
      showFeedback('neutral', head, result, explain);
      setTimeout(() => { if (!S.over) { nextTurn(); nextQuestion(); } }, PULL_ANIM_MS + 500);
      return;
    }

    if (correct) {
      // Tim yang menjawab benar menarik simpul LAWAN 1 langkah menuju garis tengah.
      if (S.turn === 'A') { S.posB++; S.pullsA++; } else { S.pos++; S.pullsB++; }
      head = '✅ Benar!';
      result = `${who} menarik tali lawan 1 langkah! 💪`;
      S.turn === 'A' ? S.scoreA++ : S.scoreB++;
      sndCorrect();
      setTimeout(sndPull, 260);
    } else {
      head = '❌ Salah!';
      result = `${who} tidak berhasil menarik tali.`;
      sndWrong();
    }

    showFeedback(correct ? 'good' : 'bad', head, result, explain);
    updateArena(true);

    setTimeout(() => {
      if (checkWin()) return;
      hideFeedback();
      if (correct) {
        // Pemenang mempertahankan giliran saat rot=1; tetap rotasi bila rot>1
        S.turnsInRound++;
        if (S.turnsInRound >= S.rot) { S.turnsInRound = 0; S.turn = S.turn === 'A' ? 'B' : 'A'; }
        updateTurnUI();
      } else {
        nextTurn();
      }
      nextQuestion();
    }, PULL_ANIM_MS + 600);
  }

  /* ── Arena ── */
  function updateArena(animate) {
    /* Simpul Biru mulai di kiri (5 langkah dari tengah) dan tertarik MENGHADAP
       garis tengah; begitu juga simpul Merah dari kanan. Persen dihitung dari
       sisi masing-masing: pos=0 → 8% dari tepi, pos=WIN_STEPS → tepat 50%. */
    const half = WIN_STEPS;
    /* Simpul bergerak 12% → 50% (Biru) dan 88% → 50% (Merah); 12/88 dipilih
       supaya BADAN karakter (yang menempel di simpul) tidak terpotong tepi. */
    const leftPos = 12 + (S.pos / half) * 38;   // 12% … 50%
    const rightPos = 88 - (S.posB / half) * 38; // 88% … 50%
    el.knotA.style.left = leftPos + '%';
    el.knotB.style.left = rightPos + '%';
    placeCritters(leftPos, rightPos);
    drawRope(leftPos, rightPos);
    el.countA.innerHTML = `<b>${S.pullsA}</b> tarikan`;
    el.countB.innerHTML = `<b>${S.pullsB}</b> tarikan`;
    el.dangerLeft.classList.toggle('hot', S.pos >= half - 1);
    el.dangerRight.classList.toggle('hot', S.posB >= half - 1);
    if (animate) {
      el.arena.classList.remove('arena-shake');
      void el.arena.offsetWidth; // restart animasi
      el.arena.classList.add('arena-shake');
    }
  }

  /* ── Posisi karakter ──
     Ukuran karakter dihitung dari geometri arena supaya DUA syarat terpenuhi
     sekaligus: tangan (77/150 ≈ 51% tinggi karakter) tepat di garis tali
     (46% tinggi arena) DAN kaki (100% tinggi karakter) tepat di rumput
     (70% tinggi arena — batas atas area hijau). Jarak tali→rumput = 24%
     tinggi arena = 36% tinggi karakter → tinggi karakter = ⅔ tinggi arena.
     Posisi horizontal: titik tangan (viewBox x≈102) menempel di simpul tim. */
  const ROPE_FRAC = 0.46, GROUND_FRAC = 0.70, HAND_FRAC = 77 / 150;
  function placeCritters(leftPos, rightPos) {
    const arenaH = el.arena.clientHeight || 1;
    const ropeYpx = arenaH * ROPE_FRAC;
    /* Tinggi karakter maksimum 35% tinggi arena; kaki selalu tepat di rumput
       karena rumput digeser mengikuti kaki lewat CSS var --ground-top. */
    const hMax = arenaH * 0.35;
    const hNatural = (GROUND_FRAC - ROPE_FRAC) * arenaH / (1 - HAND_FRAC);
    const h = Math.min(hNatural, hMax);
    const w = h * (120 / 150);                                      // rasio viewBox
    for (const [crit, xPct, flip] of [[el.critterA, leftPos, false], [el.critterB, rightPos, true]]) {
      const svg = crit.querySelector('.boy');
      if (!svg) continue;
      svg.style.width = w.toFixed(1) + 'px';
      /* Badan berpusat di simpul: tangan memegang tali tepat di depan dada
         (lengan SVG memanjang ke arah lawan melewati pusat badan). */
      svg.style.setProperty('--flip', flip ? '-1' : '1');
      svg.style.left = `calc(${xPct}% - ${(w / 2).toFixed(1)}px)`;
      svg.style.right = 'auto';
      svg.style.top = (ropeYpx - h * HAND_FRAC) + 'px';
    }
    // Rumput digeser agar permukaannya tepat di kaki karakter:
    const footY = ropeYpx + h * (1 - HAND_FRAC);   // posisi kaki dalam px
    el.arena.style.setProperty('--ground-top', (footY / arenaH * 100).toFixed(2) + '%');
  }

  /* Saat ukuran jendela berubah (mis. pindah mode layar penuh di PID),
     posisi karakter & kurva tali dihitung ulang. */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => updateArena(false), 120);
  });

  /* ── Tali (kurva SVG) ──
     Tali tegang dari tepi lapangan, melewati badan tiap karakter di titik
     tangan (~70% tinggi karakter), lalu MELLENGUNG kendor di antara kedua
     tangan. Saat salah satu simpul mendekati garis tengah, tali makin tegang
     (kendurnya berkurang) — kesan tarikan makin kuat. */
  const ROPE_Y = 46;          // ketinggian tali di viewBox (tangan karakter)
  function drawRope(leftPos, rightPos) {
    const p = el.ropePath;
    if (!p) return;
    const midL = leftPos + 2;   // titik tangan sedikit di dalam dari simpul
    const midR = rightPos - 2;
    const gap = Math.max(0, midR - midL);
    // makin sempit jaraknya, makin tegang tali (kendur maks 4 satuan)
    const sag = Math.min(4, gap * 0.09);
    const sagY = ROPE_Y + (gap <= 4 ? 0 : sag);
    p.setAttribute('d',
      `M 0 ${ROPE_Y} L ${leftPos.toFixed(2)} ${ROPE_Y} ` +
      `Q ${((midL + midR) / 2).toFixed(2)} ${sagY.toFixed(2)} ${midR.toFixed(2)} ${ROPE_Y} ` +
      `L 100 ${ROPE_Y}`);
  }

  /* ── Menang / kalah ── */
  function checkWin() {
    if (S.pos >= WIN_STEPS) return endGame('B', 'A');  // simpul Biru sampai tengah
    if (S.posB >= WIN_STEPS) return endGame('A', 'B'); // simpul Merah sampai tengah
    return false;
  }

  function endGame(winnerSide, loserSide) {
    S.over = true;
    stopTimer();
    hideFeedback();
    el.knotA.classList.remove('center-hit');
    el.knotB.classList.remove('center-hit');
    sndWin();

    const loserName = loserSide === 'A' ? S.nameA : S.nameB;
    const winnerName = winnerSide === 'A' ? S.nameA : S.nameB;
    const loseKnot = loserSide === 'A' ? el.knotA : el.knotB;
    loseKnot.classList.add('center-hit');
    const title = `🏆 ${winnerName} menang!`;
    const sub = `Tali ${loserName} tertarik sampai menyentuh garis tengah! ` +
      `(${winnerSide === 'A' ? S.pullsA : S.pullsB} tarikan vs ${winnerSide === 'A' ? S.pullsB : S.pullsA})`;
    show(el.screenResult);
    el.resultTitle.textContent = title;
    el.resultSub.textContent = sub;
    el.trophy.textContent = winnerSide === 'A' ? '💙🏆' : '🏆❤️';
    el.statA.textContent = S.pullsA;
    el.statB.textContent = S.pullsB;
    el.statDraw.textContent = S.draw;
    el.statALabel.textContent = S.nameA;
    el.statBLabel.textContent = S.nameB;
    return true;
  }

  /* ── Feedback ── */
  function showFeedback(kind, head, result, explain) {
    el.feedback.className = 'feedback ' + kind;
    el.fbHead.textContent = head;
    el.fbResult.textContent = result;
    el.fbExplain.textContent = explain || '';
    el.feedback.hidden = false;
  }
  function hideFeedback() { el.feedback.hidden = true; }

  /* ── Layar penuh ── */
  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }

  /* ── Keyboard (cadangan untuk PID tanpa sentuhan) ── */
  document.addEventListener('keydown', e => {
    if (el.screenPlay.hidden || S.over) return;
    const k = e.key.toUpperCase();
    const map = { A: 0, B: 1, C: 2, D: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
    if (k in map && !S.locked) onAnswer(map[k], el.optWrap.children[map[k]]);
  });

  /* ── Event listeners ── */
  el.optWrap.addEventListener('click', e => {
    const btn = e.target.closest('.opt');
    if (btn && !btn.disabled) onAnswer(parseInt(btn.dataset.i, 10), btn);
  });
  el.btnStart.addEventListener('click', startGame);
  el.btnFull.addEventListener('click', toggleFullscreen);
  el.btnFull2.addEventListener('click', toggleFullscreen);
  el.btnQuit.addEventListener('click', () => { stopTimer(); S.over = true; show(el.screenMenu); });
  el.btnAgain.addEventListener('click', startGame);
  el.btnBackMenu.addEventListener('click', () => show(el.screenMenu));
  el.btnSound.addEventListener('click', () => {
    S.sound = !S.sound;
    el.btnSound.textContent = S.sound ? '🔊' : '🔇';
  });
  el.selSubject.addEventListener('change', refreshPoolInfo);
  el.selLevel.addEventListener('change', refreshPoolInfo);

  /* ── Mulai ── */
  initMenu();
})();

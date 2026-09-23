/**
 * Game Benar / Salah — Kelas 3 SD
 * Alur: menu (pilih mapel/jumlah soal/kesulitan/timer) → bermain dengan kamera
 * (berdiri di kiri = BENAR, di kanan = SALAH) → layar nilai + pembahasan.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const LEVEL_LABEL = { mudah: 'Mudah', sedang: 'Sedang', sulit: 'Sulit' };
  const MODE = { kamera: 'kamera', keduanya: 'keduanya', sentuh: 'sentuh' };

  const S = {
    subject: '', count: 10, level: 'mudah', inputMode: MODE.kamera,
    timerOn: false, timerSec: 20, sensitivity: 3, dwell: 800, sound: true,
    questions: [], index: 0, answers: [], benar: 0, streak: 0, best: 0,
    locked: false, startedAt: 0, timerId: null, deadline: 0
  };

  let vision = null;
  let stream = null;
  let cameras = [];
  let camIndex = -1;
  let cameraError = null;
  const videos = () => [$('cam'), $('camPreview')].filter(Boolean);

  /* ───────── util ───────── */
  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function show(screen) {
    ['screenMenu', 'screenPlay', 'screenResult'].forEach(id => { $(id).hidden = id !== screen; });
  }

  /* ───────── suara ───────── */
  let audioCtx = null;
  function beep(freqs, dur = 0.14, type = 'sine') {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = type;
        o.frequency.value = f;
        o.connect(g); g.connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + i * dur;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.start(t0); o.stop(t0 + dur + 0.02);
      });
    } catch (e) { /* audio tidak tersedia */ }
  }
  const soundRight = () => beep([660, 990], 0.13);
  const soundWrong = () => beep([300, 200], 0.18, 'square');
  const soundTime = () => beep([420, 320, 220], 0.16, 'triangle');

  /* ───────── kamera ───────── */
  async function listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      cameras = all.filter(d => d.kind === 'videoinput');
    } catch (e) { cameras = []; }
  }

  async function startCamera(index) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraError = 'Peramban ini tidak menyediakan akses kamera (butuh HTTPS atau localhost).';
      setPreviewMsg(cameraError);
      return false;
    }
    if (index === undefined || index === null) index = camIndex;

    /* Beberapa perangkat (terutama Android & webcam USB lama) menolak permintaan
       resolusi/device tertentu. Coba dari yang paling spesifik ke paling longgar. */
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!cameras.length) await listCameras();
      const deviceId = cameras.length && index >= 0 ? cameras[index].deviceId : null;
      const videoOptions = [
        Object.assign({ width: { ideal: 1280 }, height: { ideal: 720 } },
          deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
        true
      ];
      for (const video of videoOptions) {
        try {
          stopCamera();
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
          camIndex = deviceId ? index : -1;
          videos().forEach(v => { v.srcObject = stream; v.play().catch(() => {}); });
          cameraError = null;
          setPreviewMsg('');
          if (vision) { vision.calibrate(); vision.unlock(); }
          updateStageNote(true);
          return true;
        } catch (err) { lastErr = err; }
      }
      index = -1;   // mungkin device berubah → daftar ulang lalu coba tanpa deviceId
    }
    cameraError = describeCamError(lastErr);
    setPreviewMsg(cameraError);
    updateStageNote(true);
    return false;
  }

  function describeCamError(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError') return 'Izin kamera ditolak. Izinkan kamera di pengaturan peramban lalu coba lagi.';
    if (n === 'NotFoundError') return 'Kamera tidak ditemukan pada perangkat ini.';
    if (n === 'NotReadableError') return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.';
    return 'Kamera gagal dinyalakan: ' + (err && err.message ? err.message : n || 'tidak diketahui');
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  function setPreviewMsg(msg) {
    const el = $('previewMsg');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function cameraLive() {
    return !!(stream && stream.getVideoTracks().some(t => t.readyState === 'live'));
  }

  /* ───────── menu ───────── */
  function fillSubjects() {
    const list = QuestionSource.subjectsFor(S.level);
    $('selSubject').innerHTML = list.map(s => `<option value="${s.id}">${s.icon} ${s.name}</option>`).join('');
    if (!list.some(s => s.id === S.subject)) S.subject = list.length ? list[0].id : '';
    $('selSubject').value = S.subject;
  }

  function updatePoolInfo() {
    const n = QuestionSource.countFor(S.subject, S.level);
    const maks = Math.min(S.count, n);
    $('poolInfo').textContent = n
      ? `Tersedia ${n} soal ${LEVEL_LABEL[S.level].toLowerCase()} untuk mapel ini — permainan memakai ${maks} soal.`
      : 'Belum ada soal untuk pilihan ini. Pilih tingkat atau mapel lain.';
    $('btnStart').disabled = n === 0;
  }

  function updateSourceBadge() {
    const b = $('sourceBadge');
    if (QuestionSource.isFirestore) {
      b.textContent = 'Firestore';
      b.classList.add('fire');
      b.title = QuestionSource.reason || 'Soal dimuat dari Firestore';
    } else {
      b.textContent = 'Bank bawaan';
      b.classList.remove('fire');
      b.title = QuestionSource.reason || 'Memakai bank soal bawaan (offline)';
    }
  }

  function secureHint() {
    if (window.isSecureContext || location.protocol === 'file:') { $('secureHint').hidden = true; return; }
    $('secureHint').hidden = false;
    $('secureHint').innerHTML = 'Halaman ini dibuka lewat <b>http</b> sehingga kamera diblokir peramban. ' +
      'Buka lewat <b>https://' + location.hostname + ':8478</b> (jalankan <code>bash scripts/make-cert.sh</code> dulu), ' +
      'atau jawab dengan menyentuh layar.';
  }

  /* ───────── permainan ───────── */
  function startGame() {
    const pool = QuestionSource.questions(S.subject, S.level);
    if (!pool.length) { toast('Tidak ada soal untuk pilihan ini.'); return; }
    S.count = Number($('selCount').value);
    S.questions = shuffle(pool).slice(0, Math.min(S.count, pool.length));
    S.index = 0; S.answers = []; S.benar = 0; S.streak = 0; S.best = 0;
    S.startedAt = Date.now();
    $('chipSubject').textContent = $('selSubject').selectedOptions[0].textContent;
    initVision();
    if (vision) vision.start();
    show('screenPlay');
    renderQuestion();
    if (S.inputMode !== MODE.sentuh && !cameraLive()) startCamera(camIndex);
  }

  function renderQuestion() {
    const q = S.questions[S.index];
    S.locked = false;
    $('questionText').textContent = q.soal;
    $('chipProgress').textContent = `Soal ${S.index + 1}/${S.questions.length}`;
    $('chipScore').textContent = `Skor ${S.benar}`;
    $('chipStreak').hidden = S.streak < 2;
    $('chipStreak').textContent = `🔥 ${S.streak}`;
    $('feedback').hidden = true;
    $('barLeft').style.width = '0%';
    $('barRight').style.width = '0%';
    $('zoneLeft').classList.remove('hot');
    $('zoneRight').classList.remove('hot');
    if (vision) { vision.unlock(); }
    updateStageNote(true);
    startTimer();
  }

  /* Pesan pada area kamera. Hasil render di-cache agar tidak ditulis ulang
     puluhan kali per detik saat vision.js melapor tiap frame. */
  let noteKey = null;
  function updateStageNote(force) {
    const note = $('stageNote');
    let key, html;
    if (S.inputMode === MODE.sentuh) {
      key = 'sentuh';
      html = 'Sentuh sisi <b>kiri = BENAR</b> atau <b>kanan = SALAH</b>.<br>Tombol ← → juga bisa.';
    } else if (!cameraLive()) {
      key = 'off:' + (cameraError || '-');
      html = cameraError
        ? 'Kamera tidak aktif.<br>' + cameraError + '<br><b>Sentuh</b> sisi kiri/kanan atau tekan tombol ← →.'
        : 'Menyiapkan kamera…';
    } else if (vision && !vision.ready) {
      key = 'kalibrasi';
      html = 'Bersihkan area di depan kamera sebentar…<br><b>Mengambil latar ruangan</b>.';
    } else {
      key = 'siap';
      html = '';
    }
    if (!force && key === noteKey) return;
    noteKey = key;
    note.innerHTML = html;
  }

  /* ───────── timer ───────── */
  function startTimer() {
    stopTimer();
    if (!S.timerOn) { $('timerChip').hidden = true; return; }
    $('timerChip').hidden = false;
    S.deadline = performance.now() + S.timerSec * 1000;
    const tick = () => {
      const left = Math.max(0, (S.deadline - performance.now()) / 1000);
      const pct = (left / S.timerSec) * 100;
      $('timerText').textContent = Math.ceil(left);
      $('timerBar').style.width = pct + '%';
      $('timerChip').classList.toggle('low', left <= 5);
      if (left <= 0) { stopTimer(); if (!S.locked) answer(null, true); }
    };
    tick();
    S.timerId = setInterval(tick, 100);
  }
  function stopTimer() {
    if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
  }

  /* ───────── menjawab ───────── */
  function answer(value, timeout) {
    if (S.locked) return;
    S.locked = true;
    stopTimer();
    if (vision) vision.lock();

    const q = S.questions[S.index];
    const tepat = value !== null && value === q.jawaban;
    if (tepat) {
      S.benar++;
      S.streak++;
      S.best = Math.max(S.best, S.streak);
    } else {
      S.streak = 0;
    }
    S.answers.push({ q, value, tepat, timeout: !!timeout });

    const fb = $('feedback');
    fb.className = 'feedback ' + (timeout ? 'timeout' : (tepat ? 'good' : 'bad'));
    $('fbHead').textContent = timeout ? '⏰ WAKTU HABIS' : (tepat ? 'TEPAT! ✓' : 'BELUM TEPAT ✗');
    const benarTeks = q.jawaban ? 'BENAR' : 'SALAH';
    if (timeout) $('fbResult').textContent = 'Jawaban yang benar: ' + benarTeks + '.';
    else if (tepat) $('fbResult').textContent = 'Jawabanmu ' + (value ? 'BENAR' : 'SALAH') + ' — hebat!';
    else $('fbResult').textContent = 'Jawabanmu ' + (value ? 'BENAR' : 'SALAH') + ', seharusnya ' + benarTeks + '.';
    $('fbExplain').textContent = q.penjelasan || '';
    $('chipScore').textContent = `Skor ${S.benar}`;
    $('chipStreak').hidden = S.streak < 2;
    $('chipStreak').textContent = `🔥 ${S.streak}`;
    fb.hidden = false;

    if (timeout) soundTime(); else if (tepat) soundRight(); else soundWrong();
    setTimeout(() => {
      if (S.index + 1 >= S.questions.length) showResult();
      else { S.index++; renderQuestion(); }
    }, (tepat || timeout) ? 1700 : 2400);
  }

  /* ───────── hasil ───────── */
  function showResult() {
    stopTimer();
    if (vision) vision.stop();
    const total = S.answers.length;
    const nilai = total ? Math.round((S.benar / total) * 100) : 0;
    $('scoreValue').textContent = nilai;
    $('scoreCircle').style.setProperty('--p', nilai + '%');
    const durasi = Math.round((Date.now() - S.startedAt) / 1000);
    let judul = 'Ayo coba lagi!', sub = '';
    if (nilai >= 90) judul = 'Luar biasa! 🌟';
    else if (nilai >= 75) judul = 'Hebat sekali! 👏';
    else if (nilai >= 60) judul = 'Bagus, terus berlatih! 💪';
    sub = `Benar ${S.benar} dari ${total} soal · ${LEVEL_LABEL[S.level]} · ${$('chipSubject').textContent}` +
      ` · waktu ${Math.floor(durasi / 60)}m ${durasi % 60}d` + (S.best > 1 ? ` · runtutan terbaik ${S.best}` : '');
    $('resultTitle').textContent = judul;
    $('resultSub').textContent = sub;
    const bintang = nilai >= 90 ? 3 : nilai >= 70 ? 2 : nilai >= 50 ? 1 : 0;
    $('stars').textContent = '⭐'.repeat(bintang) + '☆'.repeat(3 - bintang);

    $('review').innerHTML = S.answers.map((a, i) => {
      const cls = a.timeout ? 'skip' : (a.tepat ? 'right' : 'wrong');
      const mark = a.timeout ? '⏰' : (a.tepat ? '✓' : '✗');
      const kamu = a.timeout ? 'tidak dijawab' : (a.value ? 'BENAR' : 'SALAH');
      return `<div class="rev-item ${cls}">
        <span class="rev-mark">${mark}</span>
        <div class="rev-body">
          <b>${i + 1}. ${escapeHtml(a.q.soal)}</b>
          <span>Jawabanmu: ${kamu} · Jawaban benar: ${a.q.jawaban ? 'BENAR' : 'SALAH'}${
            a.q.penjelasan ? ' — ' + escapeHtml(a.q.penjelasan) : ''}</span>
        </div></div>`;
    }).join('');

    noteKey = null;
    $('saveBox').hidden = !QuestionSource.isFirestore;
    $('btnSaveScore').disabled = false;
    $('btnSaveScore').textContent = 'Simpan nilai';
    S.nilai = nilai;
    show('screenResult');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ───────── visi kamera ───────── */
  function initVision() {
    if (vision) return;
    vision = new ZoneVision({
      video: $('cam'),
      sensitivity: S.sensitivity,
      dwellMs: S.dwell,
      onAnswer: (v) => answer(v === 'benar'),
      onUpdate: (st) => {
        $('barLeft').style.width = Math.min(100, st.left * 220) + '%';
        $('barRight').style.width = Math.min(100, st.right * 220) + '%';
        $('zoneLeft').classList.toggle('hot', st.candidate === 'benar');
        $('zoneRight').classList.toggle('hot', st.candidate === 'salah');
        updateStageNote();
      }
    });
  }

  /* ───────── pengaturan Firestore ───────── */
  function openCfg() {
    const c = QuestionSource.config || {};
    $('cfgProject').value = c.projectId || '';
    $('cfgKey').value = c.apiKey || '';
    $('cfgCol').value = c.collection || 'questions';
    $('cfgRes').value = c.resultsCollection || 'hasil';
    $('cfgStatus').textContent = QuestionSource.reason || '';
    $('modal').hidden = false;
  }

  async function saveCfg() {
    const cfg = {
      projectId: $('cfgProject').value.trim(),
      apiKey: $('cfgKey').value.trim(),
      collection: $('cfgCol').value.trim() || 'questions',
      resultsCollection: $('cfgRes').value.trim() || 'hasil'
    };
    QuestionSource.saveConfig(cfg);
    $('cfgStatus').textContent = 'Memuat soal…';
    $('btnCfgSave').disabled = true;
    await QuestionSource.init();
    $('btnCfgSave').disabled = false;
    updateSourceBadge();
    fillSubjects();
    updatePoolInfo();
    $('cfgStatus').textContent = QuestionSource.isFirestore
      ? 'Terhubung ke Firestore.'
      : (QuestionSource.reason || 'Memakai bank soal bawaan.');
    toast(QuestionSource.isFirestore ? 'Soal dimuat dari Firestore' : 'Memakai bank soal bawaan');
  }

  /* ───────── tombol ───────── */
  function bind() {
    $('selLevel').addEventListener('change', () => {
      S.level = $('selLevel').value;
      fillSubjects(); updatePoolInfo();
    });
    $('selSubject').addEventListener('change', () => { S.subject = $('selSubject').value; updatePoolInfo(); });
    $('selCount').addEventListener('change', () => { S.count = Number($('selCount').value); updatePoolInfo(); });
    $('selInput').addEventListener('change', () => {
      S.inputMode = $('selInput').value;
      if (S.inputMode !== MODE.sentuh && !cameraLive()) startCamera(camIndex);
    });
    $('chkTimer').addEventListener('change', () => {
      S.timerOn = $('chkTimer').checked;
      $('wrapTimerSec').hidden = !S.timerOn;
    });
    $('selTimer').addEventListener('change', () => { S.timerSec = Number($('selTimer').value); });
    $('rngSens').addEventListener('input', () => {
      S.sensitivity = Number($('rngSens').value);
      $('sensLabel').textContent = S.sensitivity;
      if (vision) vision.setSensitivity(S.sensitivity);
    });
    $('selDwell').addEventListener('change', () => {
      S.dwell = Number($('selDwell').value);
      if (vision) vision.setDwell(S.dwell);
    });

    $('btnCamOn').addEventListener('click', () => startCamera(0));
    $('btnCamSwitch').addEventListener('click', () => switchCamera());
    $('btnStart').addEventListener('click', startGame);

    $('zoneLeft').addEventListener('click', () => { if (!S.locked) answer(true); });
    $('zoneRight').addEventListener('click', () => { if (!S.locked) answer(false); });

    $('btnSound').addEventListener('click', () => {
      S.sound = !S.sound;
      $('btnSound').textContent = S.sound ? '🔊' : '🔇';
    });
    $('btnCalib').addEventListener('click', () => {
      if (!cameraLive()) { toast('Kamera belum menyala'); return; }
      if (vision) { vision.calibrate(); vision.unlock(); }
      updateStageNote();
      toast('Kalibrasi ulang — pastikan tidak ada orang di depan kamera');
    });
    $('btnSwitch').addEventListener('click', () => switchCamera());
    $('btnFull').addEventListener('click', toggleFull);
    $('btnFull2').addEventListener('click', toggleFull);
    $('btnQuit').addEventListener('click', () => {
      if (!S.locked && S.answers.length && !confirm('Keluar dari permainan dan lihat nilai?')) return;
      if (S.answers.length) showResult();
      else { stopTimer(); backToMenu(); }
    });

    $('btnAgain').addEventListener('click', () => { startGame(); });
    $('btnBackMenu').addEventListener('click', backToMenu);

    $('btnCfg').addEventListener('click', openCfg);
    $('btnCfgClose').addEventListener('click', () => { $('modal').hidden = true; });
    $('btnCfgSave').addEventListener('click', saveCfg);

    $('btnSaveScore').addEventListener('click', async () => {
      const nama = $('inpName').value.trim() || 'Murid';
      $('btnSaveScore').disabled = true;
      $('btnSaveScore').textContent = 'Menyimpan…';
      try {
        await QuestionSource.saveResult(null, {
          nama, mapel: S.subject, tingkat: S.level,
          benar: S.benar, jumlahSoal: S.answers.length, nilai: S.nilai
        });
        $('btnSaveScore').textContent = 'Tersimpan ✓';
        toast('Nilai tersimpan di Firestore');
      } catch (e) {
        $('btnSaveScore').disabled = false;
        $('btnSaveScore').textContent = 'Simpan nilai';
        toast('Gagal menyimpan: ' + (e.message || e), 4000);
      }
    });

    document.addEventListener('keydown', (e) => {
      if ($('screenPlay').hidden || S.locked) return;
      if (e.key === 'ArrowLeft' || e.key === '1') { e.preventDefault(); answer(true); }
      if (e.key === 'ArrowRight' || e.key === '2') { e.preventDefault(); answer(false); }
      if (e.key === 'Escape') $('modal').hidden = true;
    });
  }

  function switchCamera() {
    if (!cameras.length) { startCamera(0); return; }
    const next = (camIndex + 1) % cameras.length;
    startCamera(next).then(ok => { if (ok) toast('Kamera: ' + (cameras[next].label || 'kamera ' + (next + 1))); });
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  }

  function backToMenu() {
    stopTimer();
    if (vision) vision.stop();
    show('screenMenu');
    updatePoolInfo();
  }

  /* ───────── mulai ───────── */
  async function boot() {
    bind();
    secureHint();
    S.level = $('selLevel').value;
    S.count = Number($('selCount').value);
    S.inputMode = $('selInput').value;
    S.timerSec = Number($('selTimer').value);

    await QuestionSource.init();
    fillSubjects();
    updatePoolInfo();
    updateSourceBadge();
    if (QuestionSource.reason && !QuestionSource.isFirestore) toast(QuestionSource.reason, 4000);

    $('questionText').textContent = 'Contoh soal akan muncul di sini.';
    if (location.protocol !== 'file:') startCamera(0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

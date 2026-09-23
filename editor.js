/* Editor soal — memakai QuestionSource dari firestore.js untuk membaca bank
   bawaan (sebagai kerangka mapel) dan menyimpan soal guru ke localStorage
   ("bank editor") yang otomatis dipakai game di perangkat ini. */
(function () {
  const $ = (id) => document.getElementById(id);

  const LEVELS = ['mudah', 'sedang', 'sulit'];
  const LEVEL_LABEL = { mudah: 'Mudah', sedang: 'Sedang', sulit: 'Sulit' };

  const S = {
    mapel: null,
    tingkat: 'mudah',
    jawaban: true,
    editing: null,        // indeks soal yang sedang disunting (atau null)
    baseSubjects: []      // kerangka mapel dari bank bawaan
  };

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  function setStatus(msg, cls) {
    const el = $('edStatus');
    el.textContent = msg || '';
    el.className = 'ed-status' + (cls ? ' ' + cls : '');
  }

  /* ── mapel ── */
  function mapelOptions() {
    const seen = new Set();
    const opts = [];
    for (const s of S.baseSubjects) {
      seen.add(s.id);
      opts.push({ id: s.id, name: s.name });
    }
    const bank = QuestionSource.editorBank || {};
    for (const id in bank) {
      if (!seen.has(id)) {
        seen.add(id);
        opts.push({ id, name: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) });
      }
    }
    return opts;
  }

  function fillMapel() {
    const sel = $('fMapel');
    const cur = S.mapel;
    sel.innerHTML = mapelOptions().map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    S.mapel = sel.value;
  }

  /* ── data ──
     Daftar yang tampil/diedit = GABUNGAN: soal bawaan (atau Firestore) + soal
     buatan guru. Begitu guru menyimpan apa pun di mapel/tingkat ini, seluruh
     daftar hasil suntingannya disimpan (snapshot) — jadi soal bawaan pun bisa
     diubah atau dihapus, dan game memakai daftar itu di perangkat ini. */
  function soalAktif() {
    const bank = QuestionSource.editorBank || {};
    if (bank[S.mapel] && bank[S.mapel][S.tingkat]) return bank[S.mapel][S.tingkat];
    return QuestionSource.questions(S.mapel, S.tingkat)
      .map(q => ({ t: q.soal, a: !!q.jawaban, e: q.penjelasan || '' }));
  }

  function tulisDaftar(list) {
    const bank = Object.assign({}, QuestionSource.editorBank || {});
    bank[S.mapel] = Object.assign({}, bank[S.mapel] || {}, { [S.tingkat]: list });
    return QuestionSource.setEditorBank(bank);
  }

  function renderList() {
    const list = soalAktif();
    $('listTitle').textContent =
      `Soal ${S.mapel || '—'} · ${LEVEL_LABEL[S.tingkat]}`;
    $('listCount').textContent = list.length;
    const wrap = $('edList');
    if (!list.length) {
      wrap.innerHTML = '<p class="hint">Belum ada soal di mapel/tingkat ini (game akan memakai ' +
        'bank bawaan). Tambahkan lewat formulir di samping.</p>';
      return;
    }
    wrap.innerHTML = list.map((q, i) => `
      <div class="q-item ${q.a ? 'true' : 'false'}">
        <span class="mark">${q.a ? '✓' : '✗'}</span>
        <div class="body">
          <b>${escapeHtml(q.t)}</b>
          ${q.e ? `<span>${escapeHtml(q.e)}</span>` : ''}
        </div>
        <div class="acts">
          <button class="mini-btn" title="Ubah" data-ubah="${i}">✏️</button>
          <button class="mini-btn del" title="Hapus" data-hapus="${i}">🗑</button>
        </div>
      </div>`).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function resetForm() {
    S.editing = null;
    $('formTitle').textContent = 'Tambah soal baru';
    $('fSoal').value = '';
    $('fPenjelasan').value = '';
    setJawaban(true);
    $('btnSimpan').textContent = '💾 Simpan soal';
    $('btnBatal').hidden = true;
  }

  function setJawaban(v) {
    S.jawaban = v;
    $('ansTrue').className = 'ans-btn' + (v ? ' on-true' : '');
    $('ansFalse').className = 'ans-btn' + (!v ? ' on-false' : '');
  }

  function simpan() {
    const t = $('fSoal').value.trim();
    if (!t) { setStatus('Teks soal masih kosong.', 'err'); $('fSoal').focus(); return; }
    const q = { t, a: !!S.jawaban, e: $('fPenjelasan').value.trim() };
    const mengubah = S.editing !== null;
    const list = soalAktif().slice();
    if (mengubah) list[S.editing] = q;
    else list.push(q);
    tulisDaftar(list);
    resetForm();
    renderList();
    setStatus(mengubah ? 'Soal diperbarui — langsung dipakai game di perangkat ini. ✓'
                       : 'Soal tersimpan — langsung dipakai game di perangkat ini. ✓', 'ok');
  }

  /* ── ekspor / impor ── */
  function ekspor() {
    const bank = QuestionSource.editorBank || {};
    // Daftar mapel = bank bawaan + mapel tambahan buatan guru.
    const subjects = [];
    for (const s of S.baseSubjects) {
      subjects.push({ id: s.id, name: s.name, icon: s.icon || '📘', levels: {} });
    }
    for (const id in bank) {
      if (!subjects.some(s => s.id === id)) {
        subjects.push({ id, name: id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), icon: '📘', levels: {} });
      }
    }
    // Ekspor memuat SEMUA soal aktif (bank bawaan + soal editor) per mapel/tingkat,
    // dengan bentuk yang persis sama dengan questions.json — hasil unduhan bisa
    // langsung menggantikan www/game/questions.json lalu diterbitkan ulang.
    for (const s of subjects) {
      const merged = {};
      for (const lvl of LEVELS) {
        merged[lvl] = QuestionSource.questions(s.id, lvl).map(q => ({
          t: q.soal, a: !!q.jawaban, e: q.penjelasan || ''
        }));
      }
      s.levels = merged;
    }
    const out = JSON.stringify({ subjects }, null, 2);
    const blob = new Blob([out], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'questions.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('questions.json diunduh — gantikan www/game/questions.json lalu publish ulang.');
  }

  function impor(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data || !Array.isArray(data.subjects)) throw new Error('Struktur tidak dikenal');
        // gabungkan ke bank editor (bukan menimpa bank bawaan)
        const bank = Object.assign({}, QuestionSource.editorBank || {});
        let n = 0;
        for (const s of data.subjects) {
          if (!s || !s.id || !s.levels) continue;
          for (const lvl of LEVELS) {
            const arr = (s.levels[lvl] || []).filter(q => q && q.t).map(q => ({ t: String(q.t), a: !!q.a, e: q.e || '' }));
            if (arr.length) {
              bank[s.id] = bank[s.id] || {};
              bank[s.id][lvl] = arr;
              n += arr.length;
            }
          }
        }
        QuestionSource.setEditorBank(bank);
        fillMapel();
        renderList();
        setStatus(`Impor selesai: ${n} soal digabungkan ke bank editor.`, 'ok');
      } catch (e) {
        setStatus('Impor gagal: ' + (e.message || e), 'err');
      }
    };
    r.readAsText(file);
  }

  /* ── Firestore ── */
  function openFs() {
    const c = QuestionSource.config || {};
    $('fsProject').value = c.projectId || '';
    $('fsKey').value = c.apiKey || '';
    $('fsStatus').textContent = '';
    $('modalFs').hidden = false;
  }

  async function unggahFirestore() {
    const cfg = {
      projectId: $('fsProject').value.trim(),
      apiKey: $('fsKey').value.trim(),
      collection: (QuestionSource.config && QuestionSource.config.collection) || 'questions'
    };
    const docs = [];
    for (const s of mapelOptions()) {
      for (const lvl of LEVELS) {
        for (const q of QuestionSource.questions(s.id, lvl)) {
          docs.push({ mapel: s.id, tingkat: lvl, soal: q.soal, jawaban: !!q.jawaban, penjelasan: q.penjelasan || '' });
        }
      }
    }
    if (!docs.length) { $('fsStatus').textContent = 'Tidak ada soal untuk diunggah.'; return; }
    $('btnFsUpload').disabled = true;
    try {
      const n = await QuestionSource.uploadDocsToFirestore(cfg, docs, (sent, total) => {
        $('fsStatus').textContent = `Mengunggah… ${sent}/${total}`;
      });
      $('fsStatus').textContent = `Selesai: ${n} dokumen tertulis ke Firestore. ✓`;
      toast(`${n} soal terunggah ke Firestore.`);
    } catch (e) {
      $('fsStatus').textContent = String(e.message || e);
    }
    $('btnFsUpload').disabled = false;
  }

  /* ── pasang ── */
  async function init() {
    await QuestionSource.init();
    S.baseSubjects = QuestionSource.subjectsFor('mudah');
    fillMapel();
    renderList();
    resetForm();
    if (QuestionSource.editorCount()) {
      setStatus(`Bank editor aktif: ${QuestionSource.editorCount()} soal tersimpan di perangkat ini.`, 'ok');
    }

    $('fMapel').addEventListener('change', () => { S.mapel = $('fMapel').value; renderList(); resetForm(); });
    $('fTingkat').addEventListener('change', () => { S.tingkat = $('fTingkat').value; renderList(); resetForm(); });
    $('ansTrue').addEventListener('click', () => setJawaban(true));
    $('ansFalse').addEventListener('click', () => setJawaban(false));
    $('btnSimpan').addEventListener('click', simpan);
    $('btnBatal').addEventListener('click', () => { resetForm(); setStatus(''); });

    $('edList').addEventListener('click', (e) => {
      const bUbah = e.target.closest('[data-ubah]');
      const bHapus = e.target.closest('[data-hapus]');
      if (!bUbah && !bHapus) return;
      const list = soalAktif();
      if (bUbah) {
        const i = Number(bUbah.dataset.ubah);
        const q = list[i];
        if (!q) return;
        S.editing = i;
        $('formTitle').textContent = 'Ubah soal';
        $('fSoal').value = q.t;
        $('fPenjelasan').value = q.e || '';
        setJawaban(!!q.a);
        $('btnSimpan').textContent = '💾 Perbarui soal';
        $('btnBatal').hidden = false;
        $('fSoal').focus();
      } else if (bHapus) {
        const i = Number(bHapus.dataset.hapus);
        list.splice(i, 1);
        tulisDaftar(list);
        resetForm();
        renderList();
        setStatus('Soal dihapus.', 'ok');
      }
    });

    $('btnEkspor').addEventListener('click', ekspor);
    $('btnImpor').addEventListener('click', () => $('fileImpor').click());
    $('fileImpor').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) impor(e.target.files[0]);
      e.target.value = '';
    });

    $('btnFirestore').addEventListener('click', openFs);
    $('btnFsClose').addEventListener('click', () => { $('modalFs').hidden = true; });
    $('btnFsUpload').addEventListener('click', unggahFirestore);
    $('btnBack').addEventListener('click', () => { location.href = 'index.html'; });
  }

  init();
})();

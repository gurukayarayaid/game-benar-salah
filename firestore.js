/**
 * QuestionSource — sumber soal untuk game.
 *
 * Dua sumber, dipilih otomatis:
 *   1. Firestore (REST API, tanpa SDK) bila dikonfigurasi → soal bisa diubah
 *      guru tanpa menyentuh kode.
 *   2. Bank soal bawaan (questions.json) → selalu tersedia, jadi game tetap
 *      jalan walau internet mati atau Firestore belum diatur.
 *
 * Konfigurasi dibaca dari (urutan prioritas):
 *   - localStorage "game.firebase" (diisi dari menu ⚙ di halaman game)
 *   - berkas www/game/firebase-config.json (bisa disiapkan oleh admin sekolah)
 *
 * Bentuk koleksi Firestore (satu dokumen = satu soal):
 *   { mapel: "mtk", tingkat: "mudah", soal: "…", jawaban: true, penjelasan: "…" }
 * Nama field Inggris (subject/level/text/answer/explanation) juga diterima.
 */
(function () {
  const CFG_KEY = 'game.firebase';
  const CACHE_KEY = 'game.firebase.cache';
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 jam

  const DB = {
    config: null,             // { projectId, apiKey, collection, resultsCollection }
    source: 'lokal',          // 'firestore' | 'lokal'
    reason: '',               // alasan bila jatuh ke bank bawaan
    bank: null,               // questions.json
    subjects: [],
    docs: null,               // Map: "mapel/tingkat" -> [soal]
    loadPromise: null,
  };

  const LEVELS = ['mudah', 'sedang', 'sulit'];

  /* ---------------- konfigurasi ---------------- */
  function readLocalConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { return null; }
  }

  function normalizeConfig(c) {
    if (!c || !c.projectId) return null;
    return {
      projectId: String(c.projectId).trim(),
      apiKey: String(c.apiKey || '').trim(),
      collection: String(c.collection || 'questions').trim() || 'questions',
      resultsCollection: String(c.resultsCollection || 'hasil').trim() || 'hasil'
    };
  }

  async function loadConfig() {
    const local = normalizeConfig(readLocalConfig());
    if (local) return local;
    try {
      const r = await fetch('firebase-config.json', { cache: 'no-store' });
      if (r.ok) return normalizeConfig(await r.json());
    } catch (e) { /* berkas belum ada */ }
    return null;
  }

  function baseUrl(cfg) {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}` +
      `/databases/(default)/documents`;
  }

  /* ---------------- konversi nilai Firestore <-> JS ---------------- */
  function val(fields, names) {
    for (const n of names) {
      const f = fields[n];
      if (!f) continue;
      if ('stringValue' in f) return f.stringValue;
      if ('booleanValue' in f) return !!f.booleanValue;
      if ('integerValue' in f) return Number(f.integerValue);
      if ('doubleValue' in f) return Number(f.doubleValue);
      if ('timestampValue' in f) return f.timestampValue;
    }
    return undefined;
  }

  function toFields(q) {
    return {
      mapel: { stringValue: q.mapel },
      tingkat: { stringValue: q.tingkat },
      soal: { stringValue: q.soal },
      jawaban: { booleanValue: !!q.jawaban },
      penjelasan: { stringValue: q.penjelasan || '' }
    };
  }

  function idOf(q) {
    let h = 0;
    const s = q.mapel + '|' + q.tingkat + '|' + q.soal;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `${q.mapel}_${q.tingkat}_${(h >>> 0).toString(36)}`;
  }

  /* ---------------- bank bawaan ---------------- */
  async function loadBank() {
    if (DB.bank) return DB.bank;
    const r = await fetch('questions.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('Bank soal bawaan tidak ditemukan');
    DB.bank = await r.json();
    return DB.bank;
  }

  function bankIndex(bank) {
    const idx = new Map();
    for (const s of bank.subjects || []) {
      for (const lvl of LEVELS) {
        const arr = (s.levels && s.levels[lvl]) || [];
        if (arr.length) idx.set(s.id + '/' + lvl, arr.map(q => ({
          soal: q.t, jawaban: !!q.a, penjelasan: q.e || ''
        })));
      }
    }
    return idx;
  }

  function bankSubjects(bank) {
    return (bank.subjects || []).map(s => ({ id: s.id, name: s.name, icon: s.icon || '📘' }));
  }

  function labelFromId(id) {
    return String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /* Mapel yang hanya ada di Firestore (mis. "Bahasa Arab") tetap muncul di menu. */
  function augmentSubjects() {
    const known = new Set(DB.subjects.map(s => s.id));
    const extra = [];
    for (const key of DB.docs.keys()) {
      const id = key.split('/')[0];
      if (id && !known.has(id)) { known.add(id); extra.push({ id, name: labelFromId(id), icon: '📘' }); }
    }
    extra.sort((a, b) => a.id.localeCompare(b.id));
    DB.subjects = DB.subjects.concat(extra);
  }

  /* ---------------- Firestore ---------------- */
  async function fetchCollection(cfg) {
    const key = `${cfg.projectId}|${cfg.collection}`;
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (raw && raw.key === key && Date.now() - raw.at < CACHE_TTL && raw.docs) return raw.docs;
    } catch (e) { /* cache rusak */ }

    const docs = [];
    let token = '';
    for (let page = 0; page < 12; page++) {
      const url = `${baseUrl(cfg)}/${encodeURIComponent(cfg.collection)}?pageSize=300` +
        (cfg.apiKey ? `&key=${encodeURIComponent(cfg.apiKey)}` : '') +
        (token ? `&pageToken=${encodeURIComponent(token)}` : '');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Firestore ${res.status}: ${body.slice(0, 180)}`);
      }
      const data = await res.json();
      for (const d of data.documents || []) {
        const f = d.fields || {};
        const soal = val(f, ['soal', 'text', 't', 'pertanyaan']);
        const jawaban = val(f, ['jawaban', 'answer', 'a', 'benar']);
        if (typeof soal !== 'string' || !soal.trim() || typeof jawaban !== 'boolean') continue;
        docs.push({
          mapel: String(val(f, ['mapel', 'subject', 'mataPelajaran']) || '').trim(),
          tingkat: String(val(f, ['tingkat', 'level', 'kesulitan']) || '').trim().toLowerCase(),
          soal: soal.trim(),
          jawaban,
          penjelasan: String(val(f, ['penjelasan', 'explanation', 'pembahasan', 'e']) || '')
        });
      }
      token = data.nextPageToken || '';
      if (!token) break;
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ key, at: Date.now(), docs }));
    } catch (e) { /* penuh */ }
    return docs;
  }

  function indexDocs(docs) {
    const idx = new Map();
    for (const d of docs) {
      if (!d.mapel || LEVELS.indexOf(d.tingkat) === -1) continue;
      const k = d.mapel + '/' + d.tingkat;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ soal: d.soal, jawaban: d.jawaban, penjelasan: d.penjelasan });
    }
    return idx;
  }

  function readCachedDocs(cfg) {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (raw && raw.key === `${cfg.projectId}|${cfg.collection}` && raw.docs && raw.docs.length) return raw.docs;
    } catch (e) { /* abaikan */ }
    return null;
  }

  /* ---------------- API ---------------- */
  const QuestionSource = {
    LEVELS,
    get config() { return DB.config; },
    get source() { return DB.source; },
    get reason() { return DB.reason; },
    get isFirestore() { return DB.source === 'firestore'; },

    async init() {
      if (DB.loadPromise) return DB.loadPromise;
      DB.loadPromise = (async () => {
        await loadBank();
        DB.subjects = bankSubjects(DB.bank);
        const local = bankIndex(DB.bank);
        DB.config = await loadConfig();
        if (!DB.config) {
          DB.reason = 'Firestore belum dikonfigurasi — memakai bank soal bawaan.';
          DB.docs = local;
          return QuestionSource;
        }
        try {
          let docs = await fetchCollection(DB.config);
          if (!docs.length) throw new Error('Koleksi soal di Firestore masih kosong');
          DB.docs = indexDocs(docs);
          DB.source = 'firestore';
          // Mapel yang belum ada di Firestore tetap dilayani bank bawaan.
          for (const [k, v] of local) if (!DB.docs.has(k)) DB.docs.set(k, v);
          augmentSubjects();
          DB.reason = '';
        } catch (err) {
          const cached = readCachedDocs(DB.config);
          if (cached) {
            DB.docs = indexDocs(cached);
            DB.source = 'firestore';
            DB.reason = 'Menampilkan salinan soal terakhir (Firestore tidak terjangkau).';
            for (const [k, v] of local) if (!DB.docs.has(k)) DB.docs.set(k, v);
            augmentSubjects();
          } else {
            DB.docs = local;
            DB.source = 'lokal';
            DB.reason = String(err.message || err);
          }
        }
        return QuestionSource;
      })();
      return DB.loadPromise;
    },

    /* Daftar mapel yang benar-benar punya soal untuk tingkat tertentu. */
    subjectsFor(level) {
      const list = DB.subjects.filter(s => (DB.docs.get(s.id + '/' + level) || []).length);
      return list.length ? list : DB.subjects;
    },

    questions(subjectId, level) {
      return (DB.docs.get(subjectId + '/' + level) || []).slice();
    },

    countFor(subjectId, level) {
      return (DB.docs.get(subjectId + '/' + level) || []).length;
    },

    /* ---- Simpan konfigurasi (dipakai menu ⚙) ---- */
    saveConfig(cfg) {
      const clean = normalizeConfig(cfg);
      if (clean) localStorage.setItem(CFG_KEY, JSON.stringify(clean));
      else localStorage.removeItem(CFG_KEY);
      localStorage.removeItem(CACHE_KEY);
      DB.bank = null;
      DB.loadPromise = null;
      DB.source = clean ? 'firestore' : 'lokal';
      DB.reason = '';
      return clean;
    },

    /* ---- Unggah bank bawaan ke Firestore (dipakai halaman seed) ---- */
    async seedToFirestore(cfg, onProgress) {
      const c = normalizeConfig(cfg);
      if (!c) throw new Error('Project ID wajib diisi');
      const bank = await loadBank();
      const docs = [];
      for (const s of bank.subjects || []) {
        for (const lvl of LEVELS) {
          for (const q of (s.levels && s.levels[lvl]) || []) {
            docs.push({ mapel: s.id, tingkat: lvl, soal: q.t, jawaban: !!q.a, penjelasan: q.e || '' });
          }
        }
      }
      const CHUNK = 200;
      let sent = 0;
      for (let i = 0; i < docs.length; i += CHUNK) {
        const slice = docs.slice(i, i + CHUNK);
        const writes = slice.map(q => ({
          update: {
            name: `projects/${c.projectId}/databases/(default)/documents/${c.collection}/${idOf(q)}`,
            fields: toFields(q)
          }
        }));
        const url = `${baseUrl(c)}:commit` + (c.apiKey ? `?key=${encodeURIComponent(c.apiKey)}` : '');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes })
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Gagal mengunggah (${res.status}): ${body.slice(0, 220)}`);
        }
        sent += slice.length;
        if (onProgress) onProgress(sent, docs.length);
      }
      localStorage.removeItem(CACHE_KEY);
      return docs.length;
    },

    /* ---- Simpan nilai siswa (opsional) ---- */
    async saveResult(cfg, payload) {
      const c = normalizeConfig(cfg || DB.config);
      if (!c) throw new Error('Firestore belum dikonfigurasi');
      const fields = {
        nama: { stringValue: String(payload.nama || 'Murid') },
        mapel: { stringValue: String(payload.mapel || '') },
        tingkat: { stringValue: String(payload.tingkat || '') },
        benar: { integerValue: String(payload.benar || 0) },
        jumlahSoal: { integerValue: String(payload.jumlahSoal || 0) },
        nilai: { integerValue: String(payload.nilai || 0) },
        waktu: { stringValue: new Date().toISOString() }
      };
      const url = `${baseUrl(c)}/${encodeURIComponent(c.resultsCollection)}` +
        (c.apiKey ? `?key=${encodeURIComponent(c.apiKey)}` : '');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gagal menyimpan nilai (${res.status}): ${body.slice(0, 200)}`);
      }
      return true;
    }
  };

  window.QuestionSource = QuestionSource;
})();

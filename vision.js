/**
 * ZoneVision — deteksi posisi badan murid di depan kamera.
 *
 * Cara kerja (tanpa library / tanpa internet):
 *  1. Setiap frame video dikecilkan ke kanvas 128×96 lalu diubah ke grayscale,
 *     dicerminkan agar sesuai dengan yang dilihat murid di layar.
 *  2. Latar ruangan diambil sebagai RATA-RATA beberapa frame setelah paparan
 *     kamera tenang. Auto-exposure/white-balance kamera masih berubah di detik
 *     pertama menyala; kalau latar diambil saat itu, latar jadi "salah rekam"
 *     dan seluruh gambar dianggap berubah.
 *  3. Piksel yang berbeda jauh dari latar dianggap "ada sesuatu".
 *  4. TAPI sesuatu itu baru dianggap MURID kalau ia BARU BERGERAK. Ruangan yang
 *     berubah paparan/cahayanya (atau kamera tersenggol, kursi dipindah) juga
 *     berbeda dari latar, dan dulu itu ikut terjawab sendiri — "kamera menjawab
 *     salah padahal tidak ada yang bergerak". Karena itu tiap piksel menyimpan
 *     muatan gerakan: terisi saat frame berubah nyata, luruh perlahan bila tidak
 *     ada gerakan lagi.
 *     Tiga saringan yang harus dilewati sebelum sesuatu boleh dianggap murid:
 *       a. Derau/paparan kamera (1–6 tingkat/frame) ada di bawah ambang gerakan
 *          ADAPTIF (mengikuti derau kamera yang diukur tiap frame, 5–24 tingkat),
 *          jadi tidak pernah menumpuk. Ambang lama yang dipatok mati (12) sering
 *          terlalu tinggi: murid yang hanya MENGGESER wajah/badan (bukan berjalan)
 *          menghasilkan beda 5–12 tingkat — dulu tidak pernah terbaca.
 *       b. Gerakan murid harus terjadi di BEBERAPA FRAME dalam jendela 1,5 detik
 *          (MOT_RUN_MIN) — TIDAK harus berurutan, karena gerakan manusia sering
 *          terputus (bergerak–berhenti–bergerak). Kursi yang dipindah, kamera
 *          tersenggol, atau lampu yang dinyalakan hanya berubah 1 frame, jadi
 *          tidak pernah lolos. Jejak gerakan juga harus sudah ada SEBELUM frame
 *          ini (kursi yang muncul sekaligus tidak pernah menjawab walau ada
 *          murid berjalan di dekatnya).
 *       c. Piksel hanya dihitung sebagai gerakan badan bila ia masih "pendatang
 *          baru" (NEW_MS): daerah yang sudah lama berbeda dari latar — mis. karena
 *          paparan bergeser — tidak menjadi murid walau berkedip-kedip.
 *       d. Ambang "ada sesuatu" juga adaptif (8–24 tingkat, mengikuti derau
 *          kamera) — murid di ruangan agak gelap hanya berbeda 15–20 tingkat
 *          dari latar, dulu tidak pernah terhitung sebagai penampakan.
 *  5. Posisi murid = titik pusat GERAKAN pada gugusan terbesar (badan), bukan
 *     rata-rata semua piksel. Rata-rata seluruh piksel mudah terseret gerakan
 *     lain di sisi seberang (kursi geser, tirai, pintu, guru mondar-mandir).
 *  6. Jawaban: pusat badan di kiri 35% layar = "benar", kanan 35% = "salah",
 *     pita tengah 30% netral — dihitung pada wilayah yang SUNGGUH terlihat
 *     murid. Video memakai object-fit: cover, jadi bagian yang dipotong layar
 *     juga dipotong di analisis.
 *  7. Pusat badan harus bertahan `dwellMs` milidetik sebelum dianggap jawaban —
 *     hitungan tetap berjalan bila murid berhenti sesaat, dan dilanjutkan kira-kira
 *     1 detik setelah gerakan terakhir (RUN_VALID_MS), karena murid menggeser
 *     lalu langsung berdiri diam. Badannya minimal MIN_MASS gambar, gerakannya
 *     minimal MOT_MIN piksel; bila di sisi seberang ada murid kedua yang sebesar
 *     itu, jawaban dibatalkan.
 *  8. Kalau latar sudah tidak cocok lagi karena perubahan menyeluruh (lampu
 *     ruangan berubah), jawaban ditahan dan latar disetel ulang cepat. Guru
 *     juga bisa menekan 🎥 untuk mengambil latar baru.
 *
 * Artinya murid harus MELANGKAH atau MENGGESER badan ke sisi kiri/kanan untuk
 * menjawab — berdiri diam berjam-jam di satu sisi tidak otomatis menjawab
 * setiap soal. Latar diperbarui otomatis hanya saat tak ada orang, jadi murid
 * yang diam beberapa detik tidak "menghilang" dari deteksi.
 */
(function () {
  const W = 128, H = 96;         // ukuran kanvas analisis (cukup halus untuk membaca
                                 // wajah/bagian badan yang hanya bergeser sedikit)
  const ZONE_EDGE = 0.35;        // pusat badan di kiri 35% / kanan 65% layar (netral 30%)
  const MIN_MASS = 0.008;        // penampakan minimal ≥0,8% gambar (badan, atau sebagian
                                 // badan/wajah yang bergeser ke zona, murid yang jauh)
  const EMPTY_TOTAL = 0.02;      // dianggap kosong bila < 2% piksel total berubah
  const DOMINANCE = 0.7;         // gugusan sisi seberang ≥70% massa badan → jawaban batal
  const GLOBAL_TOTAL = 0.25;     // perubahan menyeluruh: ≥25% gambar berubah …
  const GLOBAL_COLS = 0.85;      // … di ≥85% kolom yang terlihat …
  const GLOBAL_SAMA = 0.7;       // … dan polanya bertahan antar-frame (bukan derau kamera)
  const TENANG = 3;              // paparan dianggap tenang bila rata-rata beda antar-frame < 3
  const WARM_MIN = 10, WARM_MAX = 45;

  /* ── Gerakan ──
     Muatan gerakan per piksel: terisi saat frame berubah nyata, luruh perlahan
     (linear 3 detik). Ambang gerakan TIDAK dipatok mati: ia mengikuti derau
     kamera yang diukur tiap frame (median beda antar-frame). Ambang lama (12
     tingkat) terlalu tinggi untuk kamera kelas: murid yang hanya MENGGESER
     wajah/badan (bukan berjalan) menghasilkan beda 5–12 tingkat, jadi tidak
     pernah terbaca — "sudah menggeser, tapi tidak ada respons". */
  const MOT_NOISE_K = 2.0;       // ambang = 2 × derau kamera terukur + 2
  const MOT_GATE_MIN = 5;        // batas bawah ambang gerakan (kamera bersih)
  const MOT_GATE_MAX = 24;       // batas atas (kamera berderau tinggi)
  const MOT_HOLD_MS = 3000;      // waktu luruh muatan gerakan sampai habis
  const MOT_MOVE = 0.3;          // muatan di atas ini → piksel dianggap "baru bergerak"
  const MOT_MIN = Math.round(W * H * 0.003);       // gerakan minimal pada satu gugusan
                                 // (0,3% gambar ≈ wajah/bagian badan yang bergeser)
  const MOT_FRAC = 0.06;         // … atau 6% massa gugusan (badan jauh/kecil)
  const MOT_LIVE_MIN = Math.round(W * H * 0.0012); // gerakan PADA FRAME INI untuk
                                 // memulai hitungan. Bayangan bekas tempat murid berdiri
                                 // sebelumnya tidak bergerak, jadi tidak bisa memulai.
  const MOT_COLS = 3;            // gerakan harus selebar beberapa kolom (bukan tangan/derau)
  const MOT_FRAME_MIN = 0.002;   // 0,2% gambar bergerak (frame ini) = adegan bergerak
  const PRES_THR = [0, 8, 11, 14, 18, 24];  // ambang "berbeda dari latar" per kepekaan
  const MOT_RUN_MIN = 3;         // minimal 3 frame bergerak sebelum boleh jadi jawaban;
                                 // TIDAK harus berurutan (lihat MOT_WIN_MS) karena gerakan
                                 // manusia terputus-putus (bergerak–berhenti–bergerak)
                                 // dan dulu dihitung ulang dari nol setiap jeda.
  const MOT_WIN_MS = 1500;       // jendela waktu perhitungan frame bergerak
  const RUN_VALID_MS = 900;      // setelah gerakan berhenti, jejak gerakan masih boleh
                                 // memulai/melanjutkan jawaban selama ini — murid yang
                                 // menggeser lalu langsung berdiri diam tetap direspons.
  const NEW_MS = 5000;           // piksel hanya "pendatang baru" selama ini: bagian
                                 // ruangan yang sudah lama berbeda dari latar (paparan
                                 // bergeser) tidak pernah dianggap murid walau berkedip.
  const DIAM_HOLD_MS = 20000;    // ingatan panjang "daerah ini pernah bergerak"
  const DIAM_KNOWN = 0.4;        // "ada murid tapi diam": ≥40% massa gugusan harus dari
                                 // daerah yang pernah bergerak — supaya latar basi
                                 // tidak dianggap murid yang berdiri diam.
  const MOT_FRAME_MAX = 0.35;    // > 35% gambar bergerak → kedipan lampu, bukan murid

  class ZoneVision {
    constructor(opts) {
      this.video = opts.video;
      this.sensitivity = opts.sensitivity || 3;      // 1 (peka) … 5 (kaku)
      this.dwellMs = opts.dwellMs || 800;
      this.onUpdate = opts.onUpdate || function () {};
      this.onAnswer = opts.onAnswer || function () {};

      this.canvas = document.createElement('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

      this.col = new Float32Array(W);       // massa piksel per kolom
      this.histCol = new Float32Array(W);   // piksel yang pernah bergerak (ingatan panjang)
      this.mvCol = new Float32Array(W);     // piksel yang baru bergerak per kolom
      this.liveCol = new Float32Array(W);   // piksel yang bergerak pada frame ini
      this.mvSum = new Float32Array(W);     // bobot gerakan per kolom (untuk titik pusat)
      this.mvSumPrev = new Float32Array(W); // … nilainya pada frame SEBELUMNYA
                                            // (perubahan satu frame saja — kursi
                                            // dipindah — bukan gerakan orang)
      this.mask = new Uint8Array(W * H);    // piksel di atas ambang frame ini
      this.mot = new Float32Array(W * H);   // muatan gerakan per piksel (memori pendek)
      this.hist = new Float32Array(W * H);  // pernah bergerak dalam ±20 detik terakhir
      this.pres = new Float32Array(W * H);  // sudah berapa lama piksel berbeda dari latar
      this.prev = null;                     // frame grayscale sebelumnya
      this.lastFrame = 0;
      this.bg = null;
      this.bgState = 'menyetel';            // 'menyetel' | 'siap' | 'menyetel-latar'
      this.warmN = 0;
      this.tenang = 99;
      this.blocked = null;                  // 'ganda' | 'diam' bila jawaban ditahan
      this.blockedSince = 0;
      this.diam = false;                    // ada penampakan baru tapi tidak bergerak
      this.globalN = 0;                     // frame berturut-turut dengan perubahan menyeluruh
      this.lastRecal = 0;                   // waktu kalibrasi terakhir
      this.left = 0;
      this.right = 0;
      this.movePct = 0;                     // bagian gambar yang punya memori gerakan
      this.livePct = 0;                     // bagian gambar yang bergerak frame ini
      this.motionRun = 0;                   // jumlah frame bergerak dalam jendela
      this.runMarks = [];                   // waktu frame-frame yang ada gerakan
      this.lastRunAt = -Infinity;           // kapan terakhir gerakan dinilai cukup
      this.noise = 2;                       // derau kamera terukur (tingkat/frame)
      this.gate = MOT_GATE_MIN;             // ambang gerakan aktif
      this.noiseHist = new Uint16Array(32); // sebaran beda antar-frame (untuk median)
      this.sigL = 0; this.sigR = 0;         // kekuatan gerakan per zona (indikator UI)
      this.candidate = null;
      this.since = 0;
      this.progress = 0;
      this.locked = false;
      this.emptyFrames = 0;
      this.lastUi = 0;
      this.running = false;
      this.ready = false;
    }

    /* Ambil ulang latar ruangan (dipanggil saat kelas kosong / tombol 🎥). */
    calibrate() {
      this.bg = null;
      this.globalN = 0;
      this.lastRecal = performance.now();
      this.warmN = 0;
      this.tenang = 99;
      this.bgState = 'menyetel';
      this.ready = false;
      this.emptyFrames = 0;
      this.candidate = null;
      this.progress = 0;
      this.blocked = null;
      this.prev = null;
      this.mot.fill(0);
      this.hist.fill(0);
      this.pres.fill(0);
      this.mvSumPrev.fill(0);
      this.motionRun = 0;
      this.runMarks = [];
      this.lastRunAt = -Infinity;
      this.sigL = 0; this.sigR = 0;
      this.diam = false;
      this.lastFrame = 0;
    }

    setSensitivity(v) { this.sensitivity = Number(v) || 3; }
    setDwell(ms) { this.dwellMs = Number(ms) || 800; }

    /* Kunci deteksi selama umpan balik jawaban ditampilkan. */
    lock() { this.locked = true; this.candidate = null; this.progress = 0; }
    unlock() { this.locked = false; this.candidate = null; this.progress = 0; this.since = 0; }

    start() {
      if (this.running) return;
      this.running = true;
      const step = () => {
        if (!this.running) return;
        try { this.tick(); } catch (e) { /* frame gagal → lanjut */ }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    stop() {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
    }

    /* Bagian video yang benar-benar terlihat murid di layar.
       Video memakai object-fit: cover, jadi sisi yang berlebih dipotong.
       Mengembalikan bagian yang terpotong di kiri (0 … 0,5) sebagai fraksi lebar. */
    cropX() {
      const v = this.video;
      const ew = v.clientWidth, eh = v.clientHeight;
      if (!ew || !eh || !v.videoWidth || !v.videoHeight) return 0;
      const videoRatio = v.videoWidth / v.videoHeight;
      const boxRatio = ew / eh;
      if (videoRatio <= boxRatio) return 0;      // dipotong atas–bawah → lebar utuh
      return (1 - boxRatio / videoRatio) / 2;    // dipotong kiri–kanan
    }

    /* Perkiraan perubahan kecerahan menyeluruh: median (gambar / latar) dari
       sampel piksel. Nilai > 1 = ruangan bertambah terang. Median dipakai agar
       tidak terseret oleh badan murid yang menutupi sebagian gambar. */
    medianGain(gray) {
      const s = this.sampel || (this.sampel = new Float32Array(400));
      let n = 0;
      for (let i = 0; i < gray.length && n < 400; i += 17) {
        const b = this.bg[i];
        if (b > 10) s[n++] = gray[i] / b;
      }
      if (!n) return 1;
      const arr = s.slice(0, n);
      arr.sort();
      return arr[Math.floor(n / 2)];
    }

    /* Ambil data grayscale dari video (dicermin agar sama dengan tampilan murid). */
    grab() {
      const v = this.video;
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);                       // cermin: kiri layar = kiri murid
      ctx.drawImage(v, 0, 0, W, H);
      ctx.restore();
      const d = ctx.getImageData(0, 0, W, H).data;
      const gray = new Uint8ClampedArray(W * H);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        gray[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
      }
      return gray;
    }

    tick() {
      const gray = this.grab();
      if (!gray) return;

      /* ── Latar ruangan ──
         Dirata-ratakan dari beberapa frame; tunggu sampai paparan kamera tenang
         supaya perubahan cahaya di detik pertama (auto-exposure baru menyala)
         tidak ikut tersimpan. Latar yang "salah rekam" itulah yang dulu membuat
         kamera seolah melihat orang padahal ruangan kosong. `ready` baru true
         setelah latar ini selesai. */
      if (this.bgState === 'menyetel') {
        const pertama = this.warmN === 0;
        this.warmN++;
        if (pertama) {
          this.bg = gray.slice(0);
        } else {
          const a = 1 / Math.min(this.warmN, 40);
          let sum = 0;
          for (let i = 0; i < gray.length; i++) {
            const dv = gray[i] - this.bg[i];
            sum += dv < 0 ? -dv : dv;
            this.bg[i] += dv * a;
          }
          this.tenang = sum / gray.length;
        }
        if ((this.warmN >= WARM_MIN && this.tenang < TENANG) || this.warmN >= WARM_MAX) {
          this.bgState = 'siap';
          this.ready = true;
          this.prev = gray.slice(0);
          this.mot.fill(0);
          this.hist.fill(0);
          this.pres.fill(0);
          this.onUpdate(this.state());
          return;
        }
        this.onUpdate(this.state());
        return;
      }

      /* Batas zona dihitung pada wilayah yang terlihat (lihat cropX) sehingga
         garis 35% di layar = batas jawaban yang sebenarnya. */
      const xL = this.cropX() * W;
      const xR = W - xL;
      const span = xR - xL;
      const lo = xL + span * ZONE_EDGE;
      const hi = xL + span * (1 - ZONE_EDGE);

      const now = performance.now();
      const dt = this.lastFrame ? Math.min(120, Math.max(1, now - this.lastFrame)) : 33;
      this.lastFrame = now;
      if (!this.prev) this.prev = gray.slice(0);
      const prev = this.prev;
      const mot = this.mot;
      const hist = this.hist;
      const pres = this.pres;
      const decay = dt / MOT_HOLD_MS;
      const decayHist = dt / DIAM_HOLD_MS;

      /* Ambang "ada sesuatu di sini" (beda dari latar). Dulu 13–30 dengan nilai
         bawaan 21: murid di ruangan agak gelap hanya berbeda 15–20 tingkat dari
         latar, jadi badannya tidak pernah terhitung sebagai penampakan walau
         bergerak — "sudah menggeser, tidak ada respons". Sekarang dasarnya lebih
         rendah dan selalu di atas derau kamera, jadi tetap aman di kamera berderau. */
      const thr = PRES_THR[Math.min(5, Math.max(1, this.sensitivity))];
      const gate = this.gate;                     // ambang gerakan (adaptif, lihat tick)
      const onThr = Math.max(thr, gate + 4);      // ambang keberadaan penampakan
      const rise = Math.max(20, gate * 4);        // muatan penuh ≈ 4 frame di ambang gate
      const nh = this.noiseHist;
      nh.fill(0);                                 // sebaran beda antar-frame frame ini
      const col = this.col;
      const histCol = this.histCol;
      const liveCol = this.liveCol;
      const mask = this.mask;
      const mvCol = this.mvCol, mvSum = this.mvSum;
      col.fill(0); histCol.fill(0); mvCol.fill(0); mvSum.fill(0); liveCol.fill(0);
      let total = 0, sama = 0, mvTotal = 0, live = 0;

      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          const on = Math.abs(gray[i] - this.bg[i]) > onThr;
          if (on) {
            total++;
            if (mask[i]) sama++;      // piksel yang sudah berubah di frame sebelumnya
            col[x]++;
          }
          mask[i] = on ? 1 : 0;

          /* Muatan gerakan: terisi saat frame berubah nyata, luruh perlahan. */
          const d = Math.abs(gray[i] - prev[i]);
          nh[Math.min(31, d >> 3)]++;
          let h = mot[i], hh = hist[i];
          if (d > gate) {
            h = Math.min(1, h + Math.min(1, d / rise));
            hh = 1;
            live++;
            liveCol[x]++;
          } else {
            if (h > 0) h = Math.max(0, h - decay);
            if (hh > 0) hh = Math.max(0, hh - decayHist);
          }
          mot[i] = h;
          hist[i] = hh;
          pres[i] = on ? Math.min(NEW_MS, pres[i] + dt) : 0;
          if (on && hh > MOT_MOVE) histCol[x]++;
          if (h > MOT_MOVE && pres[i] < NEW_MS) {
            mvTotal++;
            if (on) { mvCol[x]++; mvSum[x] += h; }
          }
        }
      }
      prev.set(gray);

      /* Derau kamera = MEDIAN beda antar-frame. Median dipakai supaya gerakan
         yang hanya menempati sebagian gambar tidak menaikkan ambang. Ambang
         gerakan lalu mengikuti derau kamera ini (5–24 tingkat), bukan dipatok
         mati seperti dulu (12) yang membuat gerakan halus tidak terbaca. */
      let acc = 0, med = 1;
      const half = (W * H) >> 1;
      for (let b = 0; b < 32; b++) {
        acc += nh[b];
        if (acc >= half) { med = b * 8 + 4; break; }
      }
      this.noise += (med - this.noise) * 0.15;
      this.gate = Math.min(MOT_GATE_MAX, Math.max(MOT_GATE_MIN, this.noise * MOT_NOISE_K + 2));

      /* ── Perubahan menyeluruh (lampu ruangan / paparan kamera berubah) ──
         Polanya merata, tidak padat, dan bertahan antar-frame. Latar disesuaikan
         cepat. Jawaban TIDAK lagi ditahan di sini: penyaring gerakan sudah
         menjamin daerah yang berubah tanpa gerakan tidak pernah menjawab, dan
         menahan jawaban membuat murid yang bergerak di depan kamera tidak
         mendapat respons sama sekali. */
      if (this.bg) {
        let colsBerubah = 0;
        for (let x = 0; x < W; x++) if (col[x] > 0) colsBerubah++;
        if (colsBerubah >= span * GLOBAL_COLS &&
            total >= W * H * GLOBAL_TOTAL &&
            sama / total >= GLOBAL_SAMA) {
          /* Bukan murid (murid tidak selebar hampir seluruh layar) melainkan
             ruangan yang berubah — paling sering karena cahaya/paparan kamera.
             Jawaban ditahan, lalu latar disesuaikan: perkiraan perubahan
             kecerahan (gain) dipakai untuk menaikkan/menurunkan latar, sehingga
             gambar murid tidak ikut diserap ke latar. */
          this.globalN++;
          if (this.globalN <= 45) {
            const g = this.medianGain(gray);
            if (g > 0.6 && g < 1.7 && Math.abs(g - 1) > 0.06) {
              for (let i = 0; i < gray.length; i++) {
                const t = this.bg[i] * g;
                this.bg[i] = t + (gray[i] - t) * 0.2;
              }
            }
          } else if (performance.now() - this.lastRecal > 8000) {
            /* 0,75 detik tetap menyeluruh → latar memang tidak cocok lagi
               (kamera bergeser, lampu berbeda jauh): ambil latar baru, lalu
               tunggu sampai latar itu siap. */
            this.calibrate();
            this.onUpdate(this.state(0, 0));
            return;
          }
          this.bgState = 'menyetel-latar';
        } else {
          this.bgState = 'siap';
          this.globalN = 0;
        }
      }

      /* Badan murid = GUGUSAN DENGAN MASSA TERBESAR yang BENAR-BENAR BERGERAK.
         Gugusan dari massa kolom (bukan kolom tertinggi). Ruangan yang berubah
         paparan tidak bergerak, jadi tidak pernah menjawab sendiri walau
         gambarnya jauh berbeda dari latar. */
      const zoneOf = (c) => {
        const p = c.mv > 0 ? c.movCentroid : c.centroid;
        return p < lo ? 'benar' : p > hi ? 'salah' : null;
      };
      const seen = this.seen || (this.seen = new Set());
      seen.clear();
      const clusters = [];
      for (let x = 0; x < W; x++) {
        const m = col[x];
        if (m <= 0) continue;
        if (x > 0 && col[x - 1] > m) continue;        // bukan puncak / awal dataran
        if (x < W - 1 && col[x + 1] > m) continue;
        const limb = m * 0.3;
        let a = x, b = x;
        while (a > 0 && col[a - 1] >= limb) a--;
        while (b < W - 1 && col[b + 1] >= limb) b++;
        const key = a * W + b;
        if (seen.has(key)) continue;                  // gugusan yang sama
        seen.add(key);
        let mass = 0, sum = 0, mv = 0, known = 0, lv = 0, mvW = 0, mvQ = 0, mvCols = 0, mvLama = 0;
        for (let i = a; i <= b; i++) {
          mass += col[i];
          sum += col[i] * i;
          known += histCol[i];
          lv += liveCol[i];
          mv += mvCol[i];
          mvLama += this.mvSumPrev[i];
          if (mvCol[i] > 0) mvCols++;
          mvW += mvSum[i];
          mvQ += mvSum[i] * i;
        }
        clusters.push({
          a, b, mass, known,
          live: lv, mv, mvW, mvCols, mvLama,
          centroid: sum / mass,                       // pusat seluruh penampakan
          movCentroid: mvW > 0 ? mvQ / mvW : sum / mass   // pusat gerakannya
        });
      }

      this.movePct = mvTotal / (W * H);
      this.livePct = live / (W * H);                  // gerakan pada frame ini saja
      /* Kedipan lampu/kamera: hampir seluruh gambar berubah dalam satu frame.
         (Memakai gerakan frame ini, bukan memori gerakan — murid yang berjalan
         jauh meninggalkan "jejak" memori yang luas, itu bukan kedipan.) */
      const flicker = this.livePct > MOT_FRAME_MAX;
      /* Adegan dianggap "sedang bergerak" bila beberapa frame dalam jendela
         terakhir memang ada gerakan (badan yang berjalan/menggeser selalu begitu).
         Perubahan sekaligus (kursi dipindah, kamera tersenggol, lampu menyala)
         hanya ramai 1 frame, jadi tetap tidak pernah menjawab. Dulu frame-frame
         gerakan harus BERURUTAN; gerakan manusia yang terputus-putus jadi dihitung
         ulang dari nol dan tidak pernah sampai ambang — murid sudah menggeser
         tetapi tidak ada respons sama sekali. */
      if (this.livePct >= MOT_FRAME_MIN) this.runMarks.push(now);
      const winStart = now - MOT_WIN_MS;
      while (this.runMarks.length && this.runMarks[0] < winStart) this.runMarks.shift();
      this.motionRun = this.runMarks.length;
      const adeganBergerak = this.motionRun >= MOT_RUN_MIN;
      if (adeganBergerak) this.lastRunAt = now;
      const baruBergerak = now - this.lastRunAt < RUN_VALID_MS;
      const eligible = [];
      for (const c of clusters) {
        const need = Math.max(MOT_MIN, c.mass * MOT_FRAC);
        const adaJejak = c.mv >= need && c.mvCols >= MOT_COLS;    // jejak gerakan masih ada
        const jejakLama = c.mvLama >= need * 0.5;                 // … sudah ada SEBELUM
                                 // frame ini. Kursi yang dipindah / benda yang muncul
                                 // sekaligus hanya terlihat satu frame, jadi tidak pernah
                                 // lolos walau ada murid berjalan di dekatnya.
        const gerakKini = c.live >= MOT_LIVE_MIN;                // bergerak frame ini
        const sedangDilacak = this.candidate && zoneOf(c) === this.candidate;
        /* Hitungan dimulai hanya oleh gerakan yang terjadi SEKARANG (frame ini)
           dan adegan yang memang sedang bergerak — jadi sisa bayangan tempat
           murid berdiri sebelumnya tidak bisa memulai jawaban. Hitungan yang
           sudah berjalan diteruskan memakai jejak gerakan tadi, dan murid yang
           baru saja berhenti (baruBergerak) masih tetap direspons. */
        if (!flicker && adaJejak && jejakLama &&
            ((gerakKini && adeganBergerak) ||
             (baruBergerak && gerakKini) ||
             (sedangDilacak && baruBergerak))) eligible.push(c);
      }
      eligible.sort((p, q) => (q.mass - p.mass) || (q.mv - p.mv));
      const body = eligible.length ? eligible[0] : null;

      /* Ada penampakan cukup besar tapi TIDAK bergerak — biasanya murid yang
         berdiri diam di satu sisi (mis. sisa soal sebelumnya). Bukan jawaban, tapi
         layar bisa memberi tahu guru supaya murid itu melangkah. Daerah yang tidak
         pernah bergerak (latar basi, kursi dipindah, kamera tersenggol) tidak
         dihitung karena `known`-nya nol. */
      let big = null;
      for (const c of clusters) if (!big || c.mass > big.mass) big = c;
      this.diam = !!(big && big !== body && big.mass / (W * H) >= MIN_MASS &&
                     big.known / big.mass >= DIAM_KNOWN &&
                     now - this.lastRunAt < DIAM_HOLD_MS);

      /* Ada murid kedua sebesar badan di sisi seberang? Lebih baik ditahan
         daripada salah membaca siapa yang menjawab. */
      let ganda = false;
      if (body && eligible.length > 1) {
        const bz = zoneOf(body);
        for (let k = 1; k < eligible.length; k++) {
          const o = eligible[k];
          if (o.mass < body.mass * DOMINANCE) continue;
          const oz = zoneOf(o);
          if (oz && oz !== bz) { ganda = true; break; }
        }
      }

      /* Massa per zona — untuk indikator di layar (kekuatan gerakan per sisi). */
      let leftHit = 0, rightHit = 0, nLeft = 0, nRight = 0, leftMv = 0, rightMv = 0;
      for (let x = 0; x < W; x++) {
        const c = x + 0.5;
        if (c >= xL && c < lo) { leftHit += col[x]; leftMv += mvSum[x]; nLeft++; }
        else if (c > hi && c <= xR) { rightHit += col[x]; rightMv += mvSum[x]; nRight++; }
      }
      /* Indikator "kamera melihat gerakan di sisi ini" (dipakai batang berjalan). */
      const sigDen = Math.max(1, W * H * 0.0035);
      this.sigL = Math.min(1, leftMv / sigDen);
      this.sigR = Math.min(1, rightMv / sigDen);

      // Latar diperbarui hanya ketika ruangan kosong → murid diam tetap terbaca.
      if (total / (W * H) < EMPTY_TOTAL) {
        this.emptyFrames++;
        if (this.emptyFrames > 30) {
          for (let i = 0; i < gray.length; i++) this.bg[i] += (gray[i] - this.bg[i]) * 0.25;
        }
      } else {
        this.emptyFrames = 0;
      }

      this.mvSumPrev.set(mvSum);          // bekal jejak untuk frame berikutnya

      let cand = null;
      if (body && body.mass / (W * H) >= MIN_MASS && zoneOf(body)) cand = zoneOf(body);

      if (!this.locked) {
        this.blocked = ganda ? 'ganda' : ((this.diam && !cand) ? 'diam' : null);
        if (this.blocked && !this.blockedSince) this.blockedSince = now;
        else if (!this.blocked) this.blockedSince = 0;

        if (ganda) cand = null;

        if (cand && cand === this.candidate) {
          this.progress = Math.min(1, (now - this.since) / this.dwellMs);
          if (this.progress >= 1) {
            this.locked = true;
            this.candidate = null;
            this.progress = 0;
            this.onAnswer(cand);
            return;
          }
        } else if (cand) {
          this.candidate = cand;
          this.since = now;
          this.progress = 0;
        } else {
          this.candidate = null;
          this.progress = 0;
        }
      }

      const st = this.state(
        nLeft ? leftHit / (nLeft * H) : 0,
        nRight ? rightHit / (nRight * H) : 0
      );
      if (now - this.lastUi > 30) {            // batasi update UI ~30 fps (animasi batang)
        this.lastUi = now;
        this.onUpdate(st);
      }
    }

    state(L, R) {
      L = L === undefined ? this.left : L;
      R = R === undefined ? this.right : R;
      this.left = L; this.right = R;
      return {
        left: L, right: R, candidate: this.candidate,
        progress: this.progress, locked: this.locked, ready: this.ready,
        bgState: this.bgState, blocked: this.blocked, move: this.movePct, diam: this.diam,
        sigL: this.sigL, sigR: this.sigR, gate: this.gate, noise: this.noise,
        run: this.motionRun, live: this.livePct,
        blockedMs: this.blockedSince ? performance.now() - this.blockedSince : 0
      };
    }
  }

  window.ZoneVision = ZoneVision;
})();

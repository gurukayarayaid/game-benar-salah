/**
 * ZoneVision — deteksi posisi badan murid di depan kamera.
 *
 * Cara kerja (tanpa library / tanpa internet):
 *  1. Setiap frame video dikecilkan ke kanvas 96×72 lalu diubah ke grayscale.
 *  2. Frame pertama dipakai sebagai "latar" (kelas yang kosong).
 *  3. Piksel yang berbeda jauh dari latar dianggap "ada orang".
 *  4. Jumlah piksel berbeda dihitung pada dua zona: KIRI (<=42% lebar) dan
 *     KANAN (>=58% lebar). Pita tengah diabaikan sebagai daerah netral.
 *  5. Zona yang dominan harus bertahan `dwellMs` milidetik sebelum dianggap
 *     jawaban final ("benar" = kiri, "salah" = kanan).
 *
 * Latar diperbarui otomatis hanya saat tak ada orang (dan saat kalibrasi ulang),
 * jadi murid yang diam beberapa detik tidak "menghilang" dari deteksi.
 */
(function () {
  const W = 96, H = 72;          // ukuran kanvas analisis
  const ZONE_EDGE = 0.42;        // zona kiri < 42%, zona kanan > 58%
  const MIN_PRESENCE = 0.055;    // minimal 5,5% piksel zona berubah
  const DOMINANCE = 1.30;        // zona dominan harus 30% lebih kuat
  const EMPTY_TOTAL = 0.02;      // dianggap kosong bila < 2% piksel total berubah

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

      this.bg = null;
      this.left = 0;
      this.right = 0;
      this.candidate = null;
      this.since = 0;
      this.progress = 0;
      this.locked = false;
      this.emptyFrames = 0;
      this.lastUi = 0;
      this.running = false;
      this.frames = 0;
      this.ready = false;
    }

    /* Ambil frame terbaru sebagai latar belakang (dipanggil saat kelas kosong). */
    calibrate() {
      this.bg = null;
      this.emptyFrames = 0;
      this.candidate = null;
      this.progress = 0;
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

      if (!this.bg) {                         // kalibrasi: latar = frame ini
        this.bg = gray.slice(0);
        this.frames = 0;
        this.ready = true;
        this.onUpdate(this.state());
        return;
      }

      const thr = [0, 13, 17, 21, 25, 30][Math.min(5, Math.max(1, this.sensitivity))];
      const edgeX = Math.floor(W * ZONE_EDGE);
      let leftHit = 0, rightHit = 0, total = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const diff = Math.abs(gray[i] - this.bg[i]);
          if (diff > thr) {
            total++;
            if (x < edgeX) leftHit++;
            else if (x >= W - edgeX) rightHit++;
          }
        }
      }
      const leftN = edgeX * H, rightN = edgeX * H;
      let L = leftHit / leftN, R = rightHit / rightN, T = total / (W * H);

      // Latar diperbarui hanya ketika ruangan kosong → murid diam tetap terbaca.
      if (T < EMPTY_TOTAL) {
        this.emptyFrames++;
        if (this.emptyFrames > 30) {
          for (let i = 0; i < gray.length; i++) this.bg[i] += (gray[i] - this.bg[i]) * 0.25;
        }
      } else {
        this.emptyFrames = 0;
      }

      if (!this.locked) {
        let cand = null;
        if (L >= MIN_PRESENCE && L > R * DOMINANCE) cand = 'benar';
        else if (R >= MIN_PRESENCE && R > L * DOMINANCE) cand = 'salah';

        const now = performance.now();
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

      const st = this.state(L, R);
      if (performance.now() - this.lastUi > 60) {  // batasi update UI ~16 fps
        this.lastUi = performance.now();
        this.onUpdate(st);
      }
    }

    state(L, R) {
      L = L === undefined ? this.left : L;
      R = R === undefined ? this.right : R;
      this.left = L; this.right = R;
      return {
        left: L, right: R, candidate: this.candidate,
        progress: this.progress, locked: this.locked, ready: this.ready
      };
    }
  }

  window.ZoneVision = ZoneVision;
})();

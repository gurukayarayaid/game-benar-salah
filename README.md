# Game Edukasi — Kelas 3 SD

Dua game interaktif untuk papan interaktif digital (PID) & kelas 3 SD:

## 1. Game Benar / Salah (index.html)

Game soal benar/salah yang dijawab dengan gerakan badan di depan kamera:

- **Berdiri di kiri layar = BENAR**
- **Berdiri di kanan layar = SALAH**

Teks soal tampil besar di bagian atas, kamera di bawahnya. Tersedia 210 soal
(7 mapel × mudah/sedang/sulit): Pendidikan Pancasila, Bahasa Indonesia,
Matematika, IPAS, Basa Jawa, Bahasa Inggris, dan Seni Rupa.

## 2. Tarik Tambang (tarik-tambang.html)

Game tarik tambang dua tim untuk PID — jawab soal pilihan ganda A–D untuk
menarik tali. Simpul tali setiap tim mulai 5 langkah dari garis tengah;
menyentuh garis tengah = kalah! Tersedia 105 soal pilihan ganda
(`questions-tt.json`). Buka langsung `tarik-tambang.html`.

## Menjalankan

Buka situs ini di peramban (HTTPS diperlukan agar kamera diizinkan, dan GitHub
Pages sudah HTTPS). Bila kamera tidak tersedia, soal tetap bisa dijawab dengan
menyentuh sisi kiri/kanan layar atau tombol ← →.

Saat mulai bermain, arahkan kamera ke ruangan kosong sebentar — aplikasi
memakai ruangan kosong sebagai latar deteksi. Tombol 🎥 untuk kalibrasi ulang.

## Sumber soal

- Bawaan: `questions.json` (210 soal, ikut dalam repo ini).
- Firestore: buka `seed.html` untuk mengunggah bank bawaan ke Firestore, lalu
  isi Project ID + API Key. Bila Firestore tidak terjangkau, game otomatis
  kembali memakai bank bawaan.

Bila API key dibatasi *HTTP referrers* di Google Cloud Console, tambahkan
`https://<pemilik>.github.io/*` agar permintaan dari situs ini diizinkan.

## Berkas

`index.html`, `game.css`, `game.js`, `vision.js`, `firestore.js`,
`questions.json`, `seed.html`, `icon.svg`.

Halaman ini dihasilkan dari proyek TubeMate Clone lewat `scripts/publish-pages.sh`
(lihat GAME.md). Jangan menyunting berkas di sini — sunting di `www/game/` lalu
jalankan skrip itu lagi.

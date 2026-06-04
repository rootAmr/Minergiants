# HRIS Clock-In Helper

Aplikasi lokal untuk membantu login ke HRIS Minergo, memilih default location, memakai GPS browser/default, mengambil foto webcam, lalu melakukan clock-in atau clock-out dari satu halaman.

> Catatan: tombol clock-in dan clock-out mengirim absensi sungguhan ke HRIS.

## Fitur

- Login HRIS lewat backend proxy lokal.
- Memuat opsi clock-in dari modal HRIS.
- Menyimpan setting dan session HRIS secara lokal di SQLite `data/app.db`.
- Menggunakan GPS browser jika tersedia, atau koordinat default lokal.
- Mengambil foto webcam dan mengirimnya sebagai `imageBase64`.
- Mengecek dan mengirim clock-out untuk attendance aktif.
- Migrasi otomatis dari file lama `data/settings.json` dan `data/session.json` ke SQLite jika file tersebut ada.

## Prasyarat

- Node.js 24 atau lebih baru.
- Akses jaringan ke `https://hris.minergosystems.com`.
- Browser dengan dukungan kamera dan geolocation jika ingin memakai fitur foto/GPS.

Project ini memakai SQLite bawaan Node dan tidak membutuhkan dependency eksternal.

## Menjalankan Lokal

```bash
npm start
```

Buka:

```text
http://localhost:3000
```

Port bisa diganti lewat environment variable:

```bash
PORT=4000 npm start
```

## Script

```bash
npm start    # menjalankan server
npm run dev  # menjalankan server dengan watch mode
npm run check
```

`npm run check` menjalankan syntax check untuk file JavaScript utama.

## Alur Pakai

1. Masukkan email dan password HRIS, lalu klik `Login`.
2. Pilih `Default Location`, lalu klik `Simpan Default`.
3. Klik `Nyalakan Kamera`, lalu `Ambil Foto`.
4. Opsional: klik `Ambil GPS` dan izinkan akses lokasi browser.
5. Jika muncul form `Clock Out Kemarin`, isi jam dan alasan.
6. Klik `Submit Clock In` untuk mencatat absensi masuk.
7. Untuk pulang, klik `Cek Clock Out`, lalu klik `Submit Clock Out`.

## Data Lokal

Runtime data tersimpan di folder `data/` dan sengaja di-ignore dari Git:

```text
data/app.db
data/settings.json
data/session.json
```

Jangan commit database, cookie session, password, file `.env`, atau capture respons HRIS yang berisi data pribadi.

## Endpoint Lokal

| Method | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/api/login` | Login HRIS dan menyimpan session lokal. |
| `GET` | `/api/session` | Mengecek apakah session HRIS tersimpan masih valid. |
| `GET` | `/api/settings` | Mengambil setting lokal. |
| `POST` | `/api/settings` | Menyimpan default location dan working from. |
| `GET` | `/api/dashboard-status` | Membaca status dashboard HRIS. |
| `GET` | `/api/clock-in-options` | Mengambil opsi modal clock-in HRIS. |
| `POST` | `/api/clock-in` | Mengirim clock-in ke HRIS. |
| `GET` | `/api/clock-out-options` | Mengecek attendance aktif untuk clock-out. |
| `POST` | `/api/clock-out` | Mengirim clock-out ke HRIS. |

Detail mapping request HRIS ada di [endpointapi.md](endpointapi.md).

## Struktur Repo

```text
.
├── .editorconfig
├── .env.example
├── .gitignore
├── README.md
├── SECURITY.md
├── endpointapi.md
├── package.json
├── server.js
└── public/
    ├── app.js
    ├── index.html
    └── styles.css
```

## Persiapan GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <url-repo-github>
git push -u origin main
```

Pastikan repo tetap private jika integrasi HRIS ini belum disetujui untuk dipublikasikan.

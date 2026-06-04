![HRIS Clock-In Helper](head.png)

# HRIS Clock-In Helper

Aplikasi lokal untuk membantu login ke HRIS Minergo, membaca status dashboard, memilih lokasi absensi, memakai GPS browser/default, mengelola foto clock-in, lalu melakukan clock-in atau clock-out dari satu halaman.

> Penting: tombol `Submit Clock In` dan `Submit Clock Out` benar-benar mengirim absensi ke HRIS. Gunakan hanya saat memang ingin mencatat absensi.

## Ringkasan

Project ini berjalan sebagai server Node.js lokal di `127.0.0.1`. Frontend statis berada di folder `public/`, sedangkan backend `server.js` bertindak sebagai proxy lokal ke `https://hris.minergosystems.com` dan menyimpan data runtime di SQLite lokal.

Aplikasi ini dibuat untuk penggunaan lokal/pribadi, bukan untuk deploy publik. Session, cookie HRIS, setting, dan foto tersimpan berada di komputer lokal pengguna.

## Fitur Utama

- Login HRIS lewat backend proxy lokal.
- Menyimpan session HRIS lokal supaya halaman bisa dipakai ulang tanpa login setiap refresh selama cookie masih valid.
- Membaca dashboard HRIS untuk status hari ini: clock, tanggal, status absensi, dan jam clock-in.
- Memuat modal clock-in asli dari HRIS dan menyesuaikan form lokal berdasarkan isi modal tersebut.
- Mendukung kondisi HRIS meminta perbaikan `Clock Out Kemarin` saat ada attendance lama yang belum clock-out.
- Mengambil GPS dari browser jika diizinkan, atau memakai koordinat default kantor.
- Menyimpan default location, working from, dan setting jadwal ke SQLite.
- Mengambil foto dari webcam dan mengirimnya sebagai `imageBase64`.
- Menyimpan foto ke database lokal agar bisa dipilih ulang.
- Mode random foto untuk memilih foto tersimpan secara otomatis saat clock-in.
- Mengecek attendance aktif dan melakukan clock-out dari aplikasi.
- Jadwal otomatis check-in/check-out dengan toggle ON/OFF.
- Random waktu check-in/check-out dalam rentang jam harian.
- Proteksi API lokal memakai CSRF token aplikasi dan validasi request dari localhost.
- Migrasi otomatis dari file lama `data/settings.json` dan `data/session.json` ke SQLite jika file tersebut ada.
- Test suite permanen untuk parser form HRIS dan helper jadwal.

## Prasyarat

- Node.js 24 atau lebih baru.
- Akses jaringan ke `https://hris.minergosystems.com`.
- Browser modern.
- Kamera browser jika ingin mengambil foto baru.
- Izin geolocation browser jika ingin memakai GPS asli perangkat.

Project ini tidak memakai dependency eksternal. SQLite memakai modul bawaan Node.js (`node:sqlite`).

## Menjalankan Lokal

```bash
npm start
```

Buka aplikasi di browser:

```text
http://127.0.0.1:3000
```

Jika port 3000 sudah dipakai, jalankan dengan port lain:

```bash
PORT=3100 npm start
```

Lalu buka:

```text
http://127.0.0.1:3100
```

Server hanya bind ke `127.0.0.1` supaya tidak terbuka ke jaringan luar.

## Script NPM

```bash
npm start      # menjalankan server lokal
npm run dev    # menjalankan server dengan node --watch
npm run check  # syntax check server, frontend, dan test
npm test       # menjalankan test suite Node bawaan
```

`npm run check` cocok untuk validasi cepat sebelum commit. `npm test` menjalankan test logic parser dan jadwal.

## Alur Pakai

1. Jalankan server dengan `npm start`.
2. Buka `http://127.0.0.1:3000`.
3. Masukkan email dan password HRIS, lalu klik `Login`.
4. Setelah login sukses, aplikasi akan:
   - mengecek session HRIS,
   - memuat dashboard status,
   - memuat opsi clock-in,
   - memuat opsi clock-out,
   - memuat foto tersimpan.
5. Pilih `Location` dari daftar HRIS.
6. Isi `Working From` hanya jika diperlukan, misalnya saat memilih lokasi lain.
7. Klik `Simpan Default` untuk menyimpan lokasi dan working-from lokal.
8. Klik `Nyalakan Kamera`, lalu `Ambil Foto`, atau pilih foto tersimpan.
9. Opsional: klik `Ambil GPS` dan izinkan akses lokasi browser.
10. Jika muncul form `Clock Out Kemarin`, isi jam dan alasan terlebih dahulu.
11. Klik `Submit Clock In` untuk mencatat absensi masuk.
12. Untuk pulang, klik `Cek Clock Out`, lalu klik `Submit Clock Out`.

## Kondisi Lupa Clock-Out

HRIS kadang meminta perbaikan clock-out lama sebelum user bisa clock-in baru. Aplikasi mendeteksi kondisi ini dari modal HRIS.

Jika modal HRIS memuat field berikut:

```text
fix_clock_out_time
fix_clock_out_note
last_attendance_id
last_attendance_date
```

maka aplikasi akan menampilkan form `Clock Out Kemarin` dan mewajibkan:

- jam clock-out kemarin,
- alasan lupa clock-out.

Jika user sudah checkout dengan benar, HRIS biasanya tidak mengirim field tersebut. Dalam kondisi itu, aplikasi menyembunyikan form perbaikan dan menampilkan form clock-in normal.

## Foto Clock-In

Aplikasi mendukung tiga cara menyiapkan foto:

1. Foto baru dari webcam.
2. Foto tersimpan yang dipilih manual.
3. Foto tersimpan yang dipilih otomatis lewat mode random.

Foto tersimpan berada di SQLite lokal (`data/app.db`) dan dibatasi maksimal 30 foto terbaru. Ukuran foto per item dibatasi maksimal 4 MB.

Mode random foto:

- memilih foto tersimpan saat clock-in,
- menghindari foto terakhir jika masih ada pilihan lain,
- memprioritaskan foto yang belum pernah dipakai,
- menandai foto sebagai pernah dipakai setelah clock-in sukses.

## Jadwal Otomatis

Jadwal otomatis hanya berjalan selama halaman aplikasi terbuka di browser. Aplikasi tidak membuat service/background daemon terpisah.

Pengaturan yang tersedia:

- `Schedule: ON/OFF`
- jam check-in tetap,
- jam check-out tetap,
- random check-in dalam rentang jam,
- random check-out dalam rentang jam.

Jika random aktif, target jam harian disimpan di `localStorage`, sehingga target hari itu stabil selama tanggal dan rentang waktunya sama.

Aplikasi mengecek jadwal setiap 30 detik. Window trigger adalah target waktu sampai 1 menit setelah target. Jika check-in dan check-out beririsan dalam tick yang sama, aplikasi memprioritaskan check-in terlebih dahulu dan tidak menjalankan dua aksi sekaligus.

## Data Lokal

Runtime data tersimpan di folder `data/` dan sengaja di-ignore dari Git:

```text
data/app.db
data/settings.json
data/session.json
```

Data yang disimpan di SQLite:

- `settings`: default location, working from, jadwal, random photo, dan pilihan foto.
- `hris_session`: cookie HRIS dan CSRF token terakhir.
- `saved_photos`: foto lokal, label, waktu dibuat, dan waktu terakhir dipakai.

Jangan commit database, cookie session, password, file `.env`, foto, atau capture respons HRIS yang berisi data pribadi.

## Endpoint Lokal

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | Mengambil CSRF token aplikasi lokal. |
| `POST` | `/api/login` | Login HRIS dan menyimpan session lokal. |
| `GET` | `/api/session` | Mengecek apakah session HRIS tersimpan masih valid. |
| `POST` | `/api/logout` | Menghapus session HRIS lokal. |
| `GET` | `/api/settings` | Mengambil setting lokal. |
| `POST` | `/api/settings` | Menyimpan default location, working from, jadwal, dan setting foto. |
| `GET` | `/api/dashboard-status` | Membaca status dashboard HRIS. |
| `GET` | `/api/clock-in-options` | Mengambil opsi modal clock-in HRIS. |
| `POST` | `/api/clock-in` | Mengirim clock-in ke HRIS. |
| `GET` | `/api/clock-out-options` | Mengecek attendance aktif untuk clock-out. |
| `POST` | `/api/clock-out` | Mengirim clock-out ke HRIS. |
| `GET` | `/api/photos` | Mengambil daftar foto tersimpan lokal. |
| `POST` | `/api/photos` | Menyimpan foto lokal baru. |
| `DELETE` | `/api/photos/:id` | Menghapus foto lokal. |

Request `POST` dan `DELETE` ke endpoint `/api/*` wajib membawa header:

```text
X-App-CSRF-Token: <token dari /api/bootstrap>
```

Detail mapping request HRIS ada di [endpointapi.md](endpointapi.md).

## Keamanan

- Server hanya listen di `127.0.0.1`.
- API lokal hanya menerima request dengan host/origin localhost.
- Mutating request (`POST`, `DELETE`) wajib memakai CSRF token aplikasi.
- JSON body dibatasi maksimal 6 MB.
- Foto dibatasi maksimal 4 MB per foto.
- Cookie session HRIS disimpan lokal, bukan di source code.
- Password tidak disimpan oleh aplikasi; password hanya dipakai saat request login.

Lihat juga [SECURITY.md](SECURITY.md).

## Testing dan DOD

Jalankan syntax check:

```bash
npm run check
```

Jalankan test suite:

```bash
npm test
```

Test yang tersedia:

- parser form HRIS normal,
- parser field lupa clock-out,
- normalisasi dan perbandingan jam jadwal,
- random target harian tetap di dalam rentang dan stabil untuk hari yang sama.

Checklist DOD manual sebelum dipakai:

- `npm run check` lulus.
- `npm test` lulus.
- Aplikasi bisa dibuka di `http://127.0.0.1:3000` atau port lain.
- Login HRIS sukses.
- Dashboard status termuat.
- Modal clock-in termuat.
- Jika HRIS sudah checkout, form `Clock Out Kemarin` tidak muncul.
- Jika HRIS meminta perbaikan checkout, form `Clock Out Kemarin` muncul.
- Foto tersimpan bisa dimuat.
- Jangan menekan submit clock-in/clock-out saat hanya testing.

## Troubleshooting

### Port sudah dipakai

Jika muncul pesan port sudah dipakai, jalankan dengan port lain:

```bash
PORT=3100 npm start
```

### Session habis

Jika muncul pesan session habis:

1. Klik `Logout` di aplikasi.
2. Login ulang dengan credential HRIS.
3. Klik `Refresh` jika perlu memuat ulang status.

### Kamera tidak bisa dibuka

Pastikan:

- browser memberi izin kamera,
- halaman dibuka dari `localhost` atau `127.0.0.1`,
- tidak ada aplikasi lain yang sedang memakai kamera.

### GPS tidak akurat atau gagal

Jika geolocation gagal, aplikasi memakai koordinat default. Klik `Ambil GPS` lagi setelah memberi izin lokasi browser.

### Clock-in gagal karena foto

Pastikan sudah:

- mengambil foto dari webcam, atau
- memilih foto tersimpan, atau
- mengaktifkan random foto dan memiliki minimal satu foto tersimpan.

### Clock-out tidak tersedia

Klik `Cek Clock Out`. Jika status tetap `Belum ada clock-in aktif`, berarti HRIS tidak mendeteksi attendance aktif untuk di-clock-out.

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
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
└── tests/
    └── parser-schedule.test.js
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

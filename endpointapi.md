# HRIS dan Local Helper API

Dokumentasi endpoint HRIS `https://hris.minergosystems.com` dan endpoint proxy lokal aplikasi HRIS Clock-In Helper.

> Catatan keamanan: jangan hard-code password di source code. Contoh di bawah memakai environment variable.

## Ringkasan Flow

1. `GET /login` untuk mengambil CSRF token (`_token`) dan cookie awal (`XSRF-TOKEN`, `minergohris_session`).
2. `POST /login` dengan body `application/x-www-form-urlencoded` berisi email, password, CSRF token, locale, dan field tambahan.
3. Simpan cookie hasil response (`minergohris_session`, `XSRF-TOKEN`, `device_uuid`) untuk request endpoint setelah login seperti `/account/dashboard`.
4. Untuk aplikasi lokal, browser hanya memanggil endpoint `/api/*`; server lokal meneruskan request ke HRIS dan menyimpan session/cookie di SQLite.
5. Semua endpoint lokal yang memodifikasi data (`POST`, `DELETE`) wajib membawa header `X-App-CSRF-Token` dari `GET /api/bootstrap`.

## Base URL

```text
https://hris.minergosystems.com
```

## Base URL Aplikasi Lokal

```text
http://127.0.0.1:3000
```

Port default `3000`, bisa diganti dengan environment variable `PORT`.

## Konvensi Endpoint Lokal

- Endpoint lokal hanya menerima request dari host/origin lokal: `localhost`, `127.0.0.1`, `::1`, atau `[::1]`.
- Response lokal selalu JSON dengan `Content-Type: application/json; charset=utf-8` dan `Cache-Control: no-store`.
- Request body untuk endpoint lokal memakai JSON dan header `Content-Type: application/json`.
- Endpoint lokal `GET` tidak wajib membawa `X-App-CSRF-Token`.
- Endpoint lokal `POST` dan `DELETE` wajib membawa `X-App-CSRF-Token`.
- Jika gagal, response lokal memakai HTTP `400` atau `403` dengan bentuk `{ "status": "error", "message": "..." }`.

## 1. Ambil Login Page + CSRF Token

### Request

```http
GET /login HTTP/1.1
Host: hris.minergosystems.com
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8
Accept-Language: en-US,en;q=0.9,id;q=0.8
Cache-Control: no-cache
Pragma: no-cache
User-Agent: Mozilla/5.0
Connection: keep-alive
```

### Response Penting

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=UTF-8
Set-Cookie: XSRF-TOKEN=<xsrf-token>; expires=<date>; Max-Age=7200; path=/; secure; samesite=lax
Set-Cookie: minergohris_session=<session-cookie>; expires=<date>; Max-Age=7200; path=/; httponly; samesite=lax
```

Di HTML, ambil hidden input berikut:

```html
<input type="hidden" name="_token" value="<csrf-token>" autocomplete="off">
```

Field `_token` ini wajib dikirim lagi ketika login.

## 2. Login

### Endpoint

```http
POST /login HTTP/1.1
Host: hris.minergosystems.com
```

### Headers

```http
Host: hris.minergosystems.com
Accept: application/json, text/javascript, */*; q=0.01
Accept-Language: en-US,en;q=0.9,id;q=0.8
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Origin: https://hris.minergosystems.com
Referer: https://hris.minergosystems.com/login
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0
Connection: keep-alive
Cookie: XSRF-TOKEN=<xsrf-token-from-get-login>; minergohris_session=<session-cookie-from-get-login>
```

Header yang paling penting:

- `Content-Type`: harus `application/x-www-form-urlencoded; charset=UTF-8`.
- `X-Requested-With`: membuat server mengembalikan JSON, bukan redirect HTML biasa.
- `Cookie`: harus membawa cookie dari request `GET /login`.
- `Origin` dan `Referer`: disarankan supaya request terlihat seperti request browser normal.

### Body

Format body: `application/x-www-form-urlencoded`.

```text
_token=<csrf-token-from-login-page>&email=<email>&password=<password>&locale=en&current_latitude=&current_longitude=&g_recaptcha=
```

Field body lengkap:

| Field | Wajib | Contoh | Keterangan |
| --- | --- | --- | --- |
| `_token` | Ya | `<csrf-token>` | CSRF token dari hidden input halaman login. |
| `email` | Ya | `nama@perusahaan.com` | Email akun HRIS. |
| `password` | Ya | `$HRIS_PASSWORD` | Password akun HRIS. Jangan hard-code. |
| `locale` | Ya | `en` | Bahasa UI. Bisa `en` atau `id`. |
| `current_latitude` | Tidak | kosong | Field lokasi dari form. Saat diuji boleh kosong. |
| `current_longitude` | Tidak | kosong | Field lokasi dari form. Saat diuji boleh kosong. |
| `g_recaptcha` | Tidak | kosong | Field reCAPTCHA dari form. Saat diuji kosong. |
| `remember` | Tidak | `on` | Kirim hanya jika ingin mode stay logged in. |

### Response Sukses

Response login yang diuji:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Set-Cookie: XSRF-TOKEN=<new-xsrf-token>; expires=<date>; Max-Age=7200; path=/; secure; samesite=lax
Set-Cookie: minergohris_session=<new-session-cookie>; expires=<date>; Max-Age=7200; path=/; httponly; samesite=lax
Set-Cookie: device_uuid=<device-cookie>; expires=<date>; Max-Age=34560000; path=/; secure; httponly; samesite=lax
```

```json
{"two_factor": false}
```

Jika response `two_factor` bernilai `false`, session cookie sudah bisa dipakai untuk membuka halaman yang butuh login, misalnya:

```http
GET /account/dashboard HTTP/1.1
Host: hris.minergosystems.com
Cookie: XSRF-TOKEN=<new-xsrf-token>; minergohris_session=<new-session-cookie>; device_uuid=<device-cookie>
```

## Contoh cURL Lengkap

Contoh ini otomatis mengambil CSRF token, login, lalu mengetes akses dashboard. Password dibaca dari environment variable `HRIS_PASSWORD`.

```bash
export HRIS_EMAIL='nama@perusahaan.com'
export HRIS_PASSWORD='isi_password_di_sini'

BASE_URL='https://hris.minergosystems.com'
COOKIE_JAR='/tmp/hris_cookies.txt'
LOGIN_HTML='/tmp/hris_login.html'

# 1) Ambil halaman login, CSRF token, dan cookie awal.
curl -sS -c "$COOKIE_JAR" \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' \
  -H 'Accept-Language: en-US,en;q=0.9,id;q=0.8' \
  -H 'User-Agent: Mozilla/5.0' \
  "$BASE_URL/login" \
  -o "$LOGIN_HTML"

CSRF_TOKEN=$(python3 - <<'PY'
import html
import re

text = open('/tmp/hris_login.html', encoding='utf-8').read()
match = re.search(r'name="_token" value="([^"]+)"', text)
if not match:
    raise SystemExit('CSRF token tidak ditemukan')
print(html.unescape(match.group(1)))
PY
)

# 2) Login.
curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/login" \
  -H 'Accept: application/json, text/javascript, */*; q=0.01' \
  -H 'Accept-Language: en-US,en;q=0.9,id;q=0.8' \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'Origin: https://hris.minergosystems.com' \
  -H 'Referer: https://hris.minergosystems.com/login' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'User-Agent: Mozilla/5.0' \
  --data-urlencode "_token=$CSRF_TOKEN" \
  --data-urlencode "email=$HRIS_EMAIL" \
  --data-urlencode "password=$HRIS_PASSWORD" \
  --data-urlencode 'locale=en' \
  --data-urlencode 'current_latitude=' \
  --data-urlencode 'current_longitude=' \
  --data-urlencode 'g_recaptcha='

# 3) Test session login.
curl -sS -b "$COOKIE_JAR" "$BASE_URL/account/dashboard" | grep -i '<title>'
```

Expected output dari langkah login:

```json
{"two_factor":false}
```

Expected output test dashboard:

```html
<title>Dashboard</title>
```

## Contoh JavaScript Fetch

```js
async function loginHris({ email, password }) {
  const baseUrl = 'https://hris.minergosystems.com';

  const loginPage = await fetch(`${baseUrl}/login`, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    },
  });

  const html = await loginPage.text();
  const tokenMatch = html.match(/name="_token" value="([^"]+)"/);
  if (!tokenMatch) throw new Error('CSRF token tidak ditemukan');

  const body = new URLSearchParams({
    _token: tokenMatch[1],
    email,
    password,
    locale: 'en',
    current_latitude: '',
    current_longitude: '',
    g_recaptcha: '',
  });

  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: baseUrl,
      Referer: `${baseUrl}/login`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });

  return response.json();
}
```

> Catatan: contoh `fetch` ini cocok di environment browser yang bisa menyimpan cookie dari domain HRIS. Untuk Node.js, pakai cookie jar/library HTTP client yang mendukung cookie otomatis.

## 3. Dashboard Clock In

Setelah login, tombol `Clock In` di dashboard tidak langsung mengirim absensi. Tombol ini membuka modal clock-in terlebih dahulu.

### Endpoint Modal Clock In

```http
GET /account/attendances/clock-in-modal HTTP/1.1
Host: hris.minergosystems.com
```

### Headers Modal

```http
Host: hris.minergosystems.com
Accept: text/html, */*; q=0.01
Accept-Language: en-US,en;q=0.9,id;q=0.8
Referer: https://hris.minergosystems.com/account/dashboard
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0
Connection: keep-alive
Cookie: XSRF-TOKEN=<xsrf-token>; minergohris_session=<session-cookie>; device_uuid=<device-cookie>
```

### Response Modal

Response berupa HTML modal. Ambil data penting berikut dari HTML:

```html
<form method="POST" id="clockInForm" autocomplete="off">
  <input type="hidden" name="_token" value="<csrf-token>">
  <select name="location" id="location">
    <option selected value="1" data-is-radius="1">Minergo HO Balikpapan</option>
    <option value="12" data-is-radius="1">Testing Purwokerto</option>
    <option value="13" data-is-radius="1">Testing Yogyakarta</option>
    <option value="20" data-is-radius="0">Lokasi Lainnya</option>
    <option value="29" data-is-radius="1">Minergo RO Jakarta</option>
    <option value="30" data-is-radius="1">Minergo Site Angsana</option>
  </select>
  <select name="work_from_type" id="work_from_type">
    <option value="office">Office</option>
  </select>
  <input type="hidden" id="imageBase64" name="imageBase64">
</form>
```

Pada kondisi saat dicek, modal juga membawa field tambahan karena attendance sebelumnya belum clock-out:

```html
<input type="text" name="fix_clock_out_time" id="fix_clock_out_time">
<input type="text" name="fix_clock_out_note" id="fix_clock_out_note">
<input type="hidden" name="last_attendance_id" id="last_attendance_id" value="215">
<input type="hidden" name="last_attendance_date" id="last_attendance_date" value="2026-05-20">
```

Jika `last_attendance_id` ada, aplikasi mewajibkan `fix_clock_out_time` dan `fix_clock_out_note` sebelum clock-in baru.

## 4. Store Clock In

> PENTING: endpoint ini benar-benar mencatat absensi/clock-in. Jangan test endpoint ini kecuali memang ingin membuat record clock-in.

### Endpoint

```http
POST /account/attendances/store-clock-in HTTP/1.1
Host: hris.minergosystems.com
```

### Headers

```http
Host: hris.minergosystems.com
Accept: application/json, text/javascript, */*; q=0.01
Accept-Language: en-US,en;q=0.9,id;q=0.8
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Origin: https://hris.minergosystems.com
Referer: https://hris.minergosystems.com/account/dashboard
X-Requested-With: XMLHttpRequest
User-Agent: Mozilla/5.0
Connection: keep-alive
Cookie: XSRF-TOKEN=<xsrf-token>; minergohris_session=<session-cookie>; device_uuid=<device-cookie>
```

### Body

Format body: `application/x-www-form-urlencoded`.

```text
working_from=<working-from>&location=<location-id>&work_from_type=<type>&currentLatitude=<latitude>&currentLongitude=<longitude>&imageBase64=<data-url-jpeg>&fix_clock_out_time=<time>&fix_clock_out_note=<note>&last_attendance_id=<id>&last_attendance_date=<date>&_token=<csrf-token>
```

Field body lengkap:

| Field | Wajib | Contoh | Keterangan |
| --- | --- | --- | --- |
| `working_from` | Kondisional | kosong / `Rumah` | Diisi jika pilih lokasi `Lokasi Lainnya` atau location dengan `data-is-radius="0"`. |
| `location` | Ya | `1` | ID lokasi dari modal. Saat dicek: `1` = Minergo HO Balikpapan. |
| `work_from_type` | Ya | `office` | Nilai dari dropdown `work_from_type`. |
| `currentLatitude` | Ya | `-1.237927` | Latitude dari browser geolocation. Aplikasi menolak jika kosong. |
| `currentLongitude` | Ya | `116.852852` | Longitude dari browser geolocation. Aplikasi menolak jika kosong. |
| `imageBase64` | Ya | `data:image/jpeg;base64,/9j/...` | Foto webcam hasil `canvas.toDataURL("image/jpeg")`. Aplikasi menolak jika kosong. |
| `fix_clock_out_time` | Kondisional | `18:00` | Wajib jika modal mengirim `last_attendance_id`. Untuk memperbaiki clock-out sebelumnya. |
| `fix_clock_out_note` | Kondisional | `Lupa clock out` | Wajib jika modal mengirim `last_attendance_id`. |
| `last_attendance_id` | Kondisional | `215` | Ambil dari modal jika ada. Jika tidak ada, kirim kosong atau omit. |
| `last_attendance_date` | Kondisional | `2026-05-20` | Ambil dari modal jika ada. Jika tidak ada, kirim kosong atau omit. |
| `_token` | Ya | `<csrf-token>` | CSRF token dari dashboard/modal. |

Validasi client-side yang ditemukan:

- `currentLatitude` dan `currentLongitude` tidak boleh kosong.
- `imageBase64` tidak boleh kosong.
- Jika `last_attendance_id` ada, `fix_clock_out_time` dan `fix_clock_out_note` tidak boleh kosong.
- Jika pilih `Lokasi Lainnya` (`location=20`, `data-is-radius=0`), field `working_from` perlu diisi.

### Contoh cURL Store Clock In

Contoh ini hanya template. Mengirim request ini akan membuat absensi clock-in sungguhan.

```bash
BASE_URL='https://hris.minergosystems.com'
COOKIE_JAR='/tmp/hris_cookies.txt'
CSRF_TOKEN='<csrf-token-dari-dashboard-atau-modal>'

curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$BASE_URL/account/attendances/store-clock-in" \
  -H 'Accept: application/json, text/javascript, */*; q=0.01' \
  -H 'Accept-Language: en-US,en;q=0.9,id;q=0.8' \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'Origin: https://hris.minergosystems.com' \
  -H 'Referer: https://hris.minergosystems.com/account/dashboard' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'User-Agent: Mozilla/5.0' \
  --data-urlencode "working_from=" \
  --data-urlencode "location=1" \
  --data-urlencode "work_from_type=office" \
  --data-urlencode "currentLatitude=<latitude>" \
  --data-urlencode "currentLongitude=<longitude>" \
  --data-urlencode "imageBase64=data:image/jpeg;base64,<base64-jpeg>" \
  --data-urlencode "fix_clock_out_time=<isi-jika-diminta-modal>" \
  --data-urlencode "fix_clock_out_note=<isi-jika-diminta-modal>" \
  --data-urlencode "last_attendance_id=<isi-jika-ada-di-modal>" \
  --data-urlencode "last_attendance_date=<isi-jika-ada-di-modal>" \
  --data-urlencode "_token=$CSRF_TOKEN"
```

### Contoh JavaScript Store Clock In

```js
async function storeClockIn({
  csrfToken,
  locationId = '1',
  latitude,
  longitude,
  imageBase64,
  fixClockOutTime = '',
  fixClockOutNote = '',
  lastAttendanceId = '',
  lastAttendanceDate = '',
}) {
  const baseUrl = 'https://hris.minergosystems.com';
  const body = new URLSearchParams({
    working_from: '',
    location: locationId,
    work_from_type: 'office',
    currentLatitude: String(latitude),
    currentLongitude: String(longitude),
    imageBase64,
    fix_clock_out_time: fixClockOutTime,
    fix_clock_out_note: fixClockOutNote,
    last_attendance_id: lastAttendanceId,
    last_attendance_date: lastAttendanceDate,
    _token: csrfToken,
  });

  const response = await fetch(`${baseUrl}/account/attendances/store-clock-in`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: baseUrl,
      Referer: `${baseUrl}/account/dashboard`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });

  return response.json();
}
```

## 5. Endpoint Lokal Aplikasi

Endpoint di bagian ini adalah API lokal yang dipakai frontend. Endpoint lokal tidak menyimpan password, tetapi menyimpan cookie/session HRIS dan setting aplikasi di SQLite `data/app.db`.

### Ringkasan Endpoint Lokal

| Method | Path | Butuh `X-App-CSRF-Token` | Keterangan |
| --- | --- | --- | --- |
| `GET` | `/api/bootstrap` | Tidak | Mengambil CSRF token aplikasi lokal untuk request mutasi. |
| `POST` | `/api/login` | Ya | Login ke HRIS dan menyimpan session lokal. |
| `GET` | `/api/session` | Tidak | Mengecek apakah session HRIS lokal masih valid. |
| `POST` | `/api/logout` | Ya | Menghapus session HRIS dari storage lokal. |
| `GET` | `/api/settings` | Tidak | Mengambil setting aplikasi lokal. |
| `POST` | `/api/settings` | Ya | Menyimpan setting lokasi, GPS default, jadwal, dan foto random. |
| `GET` | `/api/dashboard-status` | Tidak | Membaca status dashboard HRIS. |
| `GET` | `/api/clock-in-options` | Tidak | Mengambil field dan opsi dari modal clock-in HRIS. |
| `POST` | `/api/clock-in` | Ya | Mengirim clock-in ke HRIS. |
| `GET` | `/api/clock-out-options` | Tidak | Mengecek attendance aktif dan opsi clock-out. |
| `POST` | `/api/clock-out` | Ya | Mengirim clock-out ke HRIS. |
| `GET` | `/api/photos` | Tidak | Mengambil daftar foto tersimpan lokal. |
| `POST` | `/api/photos` | Ya | Menyimpan foto lokal untuk random/photo reuse. |
| `DELETE` | `/api/photos/:id` | Ya | Menghapus foto tersimpan lokal. |

### 5.1 Bootstrap Token Aplikasi

```http
GET /api/bootstrap HTTP/1.1
Host: 127.0.0.1:3000
```

Response:

```json
{
  "appCsrfToken": "<token-aplikasi-lokal>"
}
```

Token ini dipakai sebagai header `X-App-CSRF-Token` untuk semua request lokal non-GET.

### 5.2 Login Lokal

Endpoint ini menjalankan flow HRIS `GET /login` + `POST /login`, lalu menyimpan cookie HRIS ke SQLite.

```http
POST /api/login HTTP/1.1
Host: 127.0.0.1:3000
Content-Type: application/json
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Body:

```json
{
  "email": "nama@perusahaan.com",
  "password": "isi_password_hris"
}
```

Response sukses meneruskan payload HRIS:

```json
{
  "two_factor": false
}
```

Jika login sukses, server lokal langsung mengetes `/account/dashboard`. Jika dashboard gagal atau session tidak valid, response error akan dikembalikan.

### 5.3 Cek Session Lokal

```http
GET /api/session HTTP/1.1
Host: 127.0.0.1:3000
```

Response jika session masih valid:

```json
{
  "loggedIn": true
}
```

Response jika belum login atau session HRIS habis:

```json
{
  "loggedIn": false
}
```

Endpoint ini memanggil dashboard HRIS untuk memastikan cookie yang tersimpan masih bisa dipakai. Jika HRIS redirect ke `/login`, session lokal dikosongkan.

### 5.4 Logout Lokal

```http
POST /api/logout HTTP/1.1
Host: 127.0.0.1:3000
Content-Type: application/json
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Body bisa kosong:

```json
{}
```

Response:

```json
{
  "loggedIn": false,
  "message": "Logout sukses"
}
```

Logout lokal hanya menghapus cookie/session yang tersimpan di aplikasi lokal.

### 5.5 Settings

#### Ambil Settings

```http
GET /api/settings HTTP/1.1
Host: 127.0.0.1:3000
```

Response default:

```json
{
  "defaultLocationId": "1",
  "workingFrom": "",
  "officeLatitude": "-1.228552",
  "officeLongitude": "116.881761",
  "officeName": "PT Minergo Visi Maxima",
  "scheduleEnabled": false,
  "checkInTime": "09:00",
  "checkOutTime": "18:00",
  "randomCheckInEnabled": false,
  "randomCheckOutEnabled": false,
  "randomPhotoEnabled": false,
  "selectedPhotoId": "",
  "checkInStartTime": "08:45",
  "checkInEndTime": "09:00",
  "checkOutStartTime": "17:45",
  "checkOutEndTime": "18:15"
}
```

#### Simpan Settings

```http
POST /api/settings HTTP/1.1
Host: 127.0.0.1:3000
Content-Type: application/json
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Body boleh parsial; field yang tidak dikirim akan mempertahankan nilai lama.

```json
{
  "defaultLocationId": "1",
  "workingFrom": "",
  "officeLatitude": "-1.228552",
  "officeLongitude": "116.881761",
  "officeName": "PT Minergo Visi Maxima",
  "scheduleEnabled": true,
  "checkInTime": "09:00",
  "checkOutTime": "18:00",
  "randomCheckInEnabled": true,
  "randomCheckOutEnabled": true,
  "randomPhotoEnabled": false,
  "selectedPhotoId": "",
  "checkInStartTime": "08:45",
  "checkInEndTime": "09:00",
  "checkOutStartTime": "17:45",
  "checkOutEndTime": "18:15"
}
```

Keterangan field:

| Field | Tipe | Default | Keterangan |
| --- | --- | --- | --- |
| `defaultLocationId` | string | `1` | ID location HRIS yang dipilih sebagai default clock-in. |
| `workingFrom` | string | kosong | Diisi jika lokasi membutuhkan keterangan lokasi bebas. |
| `officeLatitude` | string | `-1.228552` | Latitude default jika GPS browser tidak dipakai. |
| `officeLongitude` | string | `116.881761` | Longitude default jika GPS browser tidak dipakai. |
| `officeName` | string | `PT Minergo Visi Maxima` | Label lokasi default yang ditampilkan di UI. |
| `scheduleEnabled` | boolean | `false` | Toggle jadwal otomatis di browser. |
| `checkInTime` | string `HH:mm` | `09:00` | Jam target check-in jika random nonaktif. |
| `checkOutTime` | string `HH:mm` | `18:00` | Jam target check-out jika random nonaktif. |
| `randomCheckInEnabled` | boolean | `false` | Jika aktif, target check-in dipilih random dari rentang check-in. |
| `randomCheckOutEnabled` | boolean | `false` | Jika aktif, target check-out dipilih random dari rentang check-out. |
| `randomPhotoEnabled` | boolean | `false` | Jika aktif, clock-in bisa memakai foto tersimpan. |
| `selectedPhotoId` | string | kosong | ID foto tersimpan yang dipakai. |
| `checkInStartTime` | string `HH:mm` | `08:45` | Awal rentang random check-in. |
| `checkInEndTime` | string `HH:mm` | `09:00` | Akhir rentang random check-in. |
| `checkOutStartTime` | string `HH:mm` | `17:45` | Awal rentang random check-out. |
| `checkOutEndTime` | string `HH:mm` | `18:15` | Akhir rentang random check-out. |

Response sukses mengembalikan settings lengkap yang sudah dinormalisasi.

### 5.6 Dashboard Status

```http
GET /api/dashboard-status HTTP/1.1
Host: 127.0.0.1:3000
```

Response:

```json
{
  "dashboardClock": "08:59",
  "dashboardDay": "Monday, 01 January 2026",
  "attendanceStatus": "not_clocked_in",
  "attendanceStatusLabel": "Not Clocked In",
  "canClockIn": true,
  "canClockOut": false,
  "attendanceId": "",
  "attendanceDate": "",
  "clockInAt": "",
  "clockOutAt": ""
}
```

Nilai `attendanceStatus`:

| Nilai | Keterangan |
| --- | --- |
| `not_clocked_in` | Dashboard menampilkan tombol clock-in. |
| `clocked_in` | Dashboard menampilkan tombol clock-out. |
| `unknown` | Status tidak bisa dipastikan dari HTML dashboard. |

Jika sedang clocked-in, endpoint ini juga mencoba mengambil detail attendance dari modal clock-out.

### 5.7 Clock-In Options Lokal

Endpoint ini memanggil HRIS `GET /account/attendances/clock-in-modal`, mem-parse HTML modal, lalu menambahkan settings lokal.

```http
GET /api/clock-in-options HTTP/1.1
Host: 127.0.0.1:3000
```

Response:

```json
{
  "csrfToken": "<csrf-token-hris>",
  "fields": {
    "_token": "<csrf-token-hris>",
    "location": "1",
    "work_from_type": "office",
    "imageBase64": ""
  },
  "locations": [
    {
      "id": "1",
      "name": "Minergo HO Balikpapan",
      "isRadius": "1",
      "selected": true
    }
  ],
  "workFromTypes": [
    {
      "value": "office",
      "label": "Office"
    }
  ],
  "lastAttendanceId": "",
  "lastAttendanceDate": "",
  "requiresFixClockOut": false,
  "rawTimeLabel": "",
  "settings": {
    "defaultLocationId": "1",
    "workingFrom": ""
  }
}
```

Catatan:

- `fields` berisi field form dari modal HRIS, termasuk input hidden yang perlu diteruskan saat clock-in.
- `locations` berasal dari dropdown `#location` di modal HRIS.
- `workFromTypes` hanya berisi value yang dikenali aplikasi: `office`, `home`, atau `other`.
- Jika `requiresFixClockOut` bernilai `true`, isi `fix_clock_out_time` dan `fix_clock_out_note` saat `POST /api/clock-in`.

### 5.8 Submit Clock-In Lokal

> PENTING: endpoint ini meneruskan clock-in sungguhan ke HRIS.

```http
POST /api/clock-in HTTP/1.1
Host: 127.0.0.1:3000
Content-Type: application/json
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Body:

```json
{
  "csrfToken": "<csrf-token-hris-opsional>",
  "location": "1",
  "work_from_type": "office",
  "working_from": "",
  "currentLatitude": "-1.228552",
  "currentLongitude": "116.881761",
  "imageBase64": "data:image/jpeg;base64,/9j/...",
  "photoId": "",
  "fix_clock_out_time": "",
  "fix_clock_out_note": "",
  "last_attendance_id": "",
  "last_attendance_date": ""
}
```

Keterangan field:

| Field | Wajib | Keterangan |
| --- | --- | --- |
| `csrfToken` | Tidak | Jika kosong, server lokal mengambil token dari modal clock-in atau session terakhir. |
| `location` | Tidak | Jika kosong, memakai `settings.defaultLocationId` atau lokasi terpilih dari modal. |
| `work_from_type` | Tidak | Default `office`. |
| `working_from` | Kondisional | Diisi untuk lokasi bebas atau non-radius. |
| `currentLatitude` | Tidak | Jika kosong, memakai `settings.officeLatitude` atau default aplikasi. |
| `currentLongitude` | Tidak | Jika kosong, memakai `settings.officeLongitude` atau default aplikasi. |
| `imageBase64` | Ya jika `photoId` kosong | Foto data URL `data:image/...;base64,...`; maksimal sekitar 4 MB setelah decode. |
| `photoId` | Tidak | ID foto tersimpan dari `/api/photos`; jika ada, `imageBase64` diambil dari database. |
| `fix_clock_out_time` | Kondisional | Wajib jika opsi clock-in mengirim `lastAttendanceId`. |
| `fix_clock_out_note` | Kondisional | Wajib jika opsi clock-in mengirim `lastAttendanceId`. |
| `last_attendance_id` | Kondisional | ID attendance lama yang perlu diperbaiki clock-out. |
| `last_attendance_date` | Kondisional | Tanggal attendance lama yang perlu diperbaiki clock-out. |

Response sukses meneruskan payload HRIS. Bentuk payload bisa berubah mengikuti HRIS, contoh:

```json
{
  "status": "success",
  "message": "Clock in success"
}
```

### 5.9 Clock-Out Options Lokal

Endpoint ini membaca dashboard HRIS, mencari `attendanceId`, lalu jika ada memanggil modal detail attendance HRIS.

```http
GET /api/clock-out-options HTTP/1.1
Host: 127.0.0.1:3000
```

Mapping HRIS yang dipakai jika ada attendance aktif:

```http
GET /account/attendances/show_clocked_hours?aid=<attendance-id> HTTP/1.1
Host: hris.minergosystems.com
```

Response jika bisa clock-out:

```json
{
  "canClockOut": true,
  "attendanceId": "123",
  "csrfToken": "<csrf-token-hris>",
  "fields": {},
  "requiresPhoto": false,
  "rawTitle": "Clock Out",
  "attendanceDate": "01-01-2026",
  "clockInAt": "01-01-2026 09:00",
  "clockOutAt": ""
}
```

Response jika tidak ada attendance aktif:

```json
{
  "canClockOut": false,
  "attendanceId": "",
  "csrfToken": "<csrf-token-hris>"
}
```

### 5.10 Submit Clock-Out Lokal

> PENTING: endpoint ini meneruskan clock-out sungguhan ke HRIS.

```http
POST /api/clock-out HTTP/1.1
Host: 127.0.0.1:3000
Content-Type: application/json
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Body:

```json
{
  "attendanceId": "123",
  "csrfToken": "<csrf-token-hris>",
  "currentLatitude": "-1.228552",
  "currentLongitude": "116.881761"
}
```

Keterangan field:

| Field | Wajib | Keterangan |
| --- | --- | --- |
| `attendanceId` | Tidak | Jika kosong, server lokal mencoba mengambil dari dashboard HRIS. |
| `csrfToken` | Tidak | Jika kosong, server lokal memakai token dari opsi clock-out atau session terakhir. |
| `currentLatitude` | Tidak | Jika kosong, memakai latitude default aplikasi. |
| `currentLongitude` | Tidak | Jika kosong, memakai longitude default aplikasi. |

Mapping HRIS yang dikirim oleh server lokal:

```http
GET /account/attendances/update-clock-in?currentLatitude=<latitude>&currentLongitude=<longitude>&_token=<csrf-token>&id=<attendance-id> HTTP/1.1
Host: hris.minergosystems.com
```

Response sukses meneruskan payload HRIS. Bentuk payload bisa berubah mengikuti HRIS, contoh:

```json
{
  "status": "success",
  "message": "Clock out success"
}
```

### 5.11 Photos Lokal

Foto disimpan lokal di SQLite table `saved_photos`. Foto dipakai untuk fitur reuse/random photo, bukan dikirim ke HRIS sampai endpoint clock-in dipanggil.

#### List Photos

```http
GET /api/photos HTTP/1.1
Host: 127.0.0.1:3000
```

Response:

```json
{
  "photos": [
    {
      "id": 1,
      "label": "Foto pagi",
      "imageBase64": "data:image/jpeg;base64,/9j/...",
      "createdAt": "2026-01-01T01:00:00.000Z",
      "usedAt": null
    }
  ]
}
```

Maksimal foto yang disimpan: 30 foto terbaru. Foto lama dihapus otomatis setelah menyimpan foto baru jika melewati limit.

#### Save Photo

```http
POST /api/photos HTTP/1.1
Host: 127.0.0.1:3000
Content-Type: application/json
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Body:

```json
{
  "label": "Foto pagi",
  "imageBase64": "data:image/jpeg;base64,/9j/..."
}
```

Response:

```json
{
  "id": 1,
  "label": "Foto pagi",
  "imageBase64": "data:image/jpeg;base64,/9j/...",
  "createdAt": "2026-01-01T01:00:00.000Z",
  "usedAt": null
}
```

Validasi:

- `imageBase64` harus diawali `data:image/`.
- Ukuran foto maksimal sekitar 4 MB setelah decode base64.
- `label` dipotong maksimal 120 karakter; jika kosong, server membuat label otomatis.

#### Delete Photo

```http
DELETE /api/photos/1 HTTP/1.1
Host: 127.0.0.1:3000
X-App-CSRF-Token: <token-aplikasi-lokal>
```

Response:

```json
{
  "deleted": true
}
```

Jika ID valid tetapi tidak ditemukan, response tetap sukses dengan `deleted: false`.

### Contoh Fetch Endpoint Lokal

```js
async function localApi(path, { method = 'GET', body, appCsrfToken } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(appCsrfToken ? { 'X-App-CSRF-Token': appCsrfToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();
  if (!response.ok || payload.status === 'error') {
    throw new Error(payload.message || `${path} gagal`);
  }
  return payload;
}

const { appCsrfToken } = await localApi('/api/bootstrap');
await localApi('/api/login', {
  method: 'POST',
  appCsrfToken,
  body: {
    email: 'nama@perusahaan.com',
    password: 'isi_password_hris',
  },
});
```

## Troubleshooting

- `419 Page Expired`: CSRF token/cookie tidak cocok; ulangi flow dari `GET /login`.
- Redirect balik ke `/login`: cookie session tidak tersimpan atau password salah.
- Response HTML, bukan JSON: pastikan header `X-Requested-With: XMLHttpRequest` dan `Accept: application/json, text/javascript, */*; q=0.01` terkirim.
- Tidak bisa akses `/account/dashboard`: gunakan cookie terbaru dari response `POST /login`, terutama `minergohris_session`.

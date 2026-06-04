# HRIS Login API

Dokumentasi endpoint login untuk `https://hris.minergosystems.com` berdasarkan form login web MConnect/HRIS.

> Catatan keamanan: jangan hard-code password di source code. Contoh di bawah memakai environment variable.

## Ringkasan Flow

1. `GET /login` untuk mengambil CSRF token (`_token`) dan cookie awal (`XSRF-TOKEN`, `minergohris_session`).
2. `POST /login` dengan body `application/x-www-form-urlencoded` berisi email, password, CSRF token, locale, dan field tambahan.
3. Simpan cookie hasil response (`minergohris_session`, `XSRF-TOKEN`, `device_uuid`) untuk request endpoint setelah login seperti `/account/dashboard`.

## Base URL

```text
https://hris.minergosystems.com
```

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

## Troubleshooting

- `419 Page Expired`: CSRF token/cookie tidak cocok; ulangi flow dari `GET /login`.
- Redirect balik ke `/login`: cookie session tidak tersimpan atau password salah.
- Response HTML, bukan JSON: pastikan header `X-Requested-With: XMLHttpRequest` dan `Accept: application/json, text/javascript, */*; q=0.01` terkirim.
- Tidak bisa akses `/account/dashboard`: gunakan cookie terbaru dari response `POST /login`, terutama `minergohris_session`.

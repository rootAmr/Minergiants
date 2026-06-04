import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://hris.minergosystems.com';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const DEFAULT_LATITUDE = '-1.228552';
const DEFAULT_LONGITUDE = '116.881761';

const jar = new Map();
let lastCsrfToken = '';
let sessionLoaded = false;
let db = null;

async function getDb() {
  if (db) return db;
  await mkdir(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

async function readState(key) {
  const database = await getDb();
  const row = database.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  if (!row) return null;
  return JSON.parse(row.value);
}

async function writeState(key, value) {
  const database = await getDb();
  database.prepare(`
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readResponsePayload(response, maxRawLength = 1000) {
  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch {
    return { raw: responseText.slice(0, maxRawLength) };
  }
}

function isFailedPayload(response, payload) {
  return !response.ok || payload.status === 'fail' || payload.status === 'error';
}

function getSetCookie(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;=]+=[^;]+)/g);
}

async function saveSession() {
  await writeState('hris_session', {
    cookies: Object.fromEntries(jar),
    lastCsrfToken,
    savedAt: new Date().toISOString(),
  });
}

async function loadSession() {
  if (sessionLoaded) return;
  sessionLoaded = true;

  try {
    let payload = await readState('hris_session');
    if (!payload && existsSync(SESSION_FILE)) {
      payload = JSON.parse(await readFile(SESSION_FILE, 'utf8'));
      await writeState('hris_session', payload);
    }
    if (!payload) return;
    for (const [key, value] of Object.entries(payload.cookies || {})) {
      if (key && value) jar.set(key, String(value));
    }
    lastCsrfToken = String(payload.lastCsrfToken || '');
  } catch {
    jar.clear();
    lastCsrfToken = '';
  }
}

async function clearSession() {
  jar.clear();
  lastCsrfToken = '';
  await saveSession();
}

function storeCookies(headers) {
  let changed = false;
  for (const cookie of getSetCookie(headers)) {
    const first = cookie.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      changed = true;
    }
  }
  return changed;
}

function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function hrisFetch(url, options = {}) {
  await loadSession();
  const headers = new Headers(options.headers || {});
  const cookies = cookieHeader();
  if (cookies) headers.set('Cookie', cookies);
  headers.set('User-Agent', headers.get('User-Agent') || 'Mozilla/5.0');

  const response = await fetch(`${BASE_URL}${url}`, {
    redirect: options.redirect || 'manual',
    ...options,
    headers,
  });
  if (storeCookies(response.headers)) await saveSession();
  return response;
}

function extractCsrfLoose(html) {
  const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1]
    || html.match(/"csrfToken"\s*:\s*"([^"]+)"/)?.[1]
    || html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i)?.[1]
    || '';

  if (token) {
    lastCsrfToken = decodeHtml(token);
    saveSession().catch(() => {});
  }
  return lastCsrfToken;
}

function extractCsrf(html) {
  const token = extractCsrfLoose(html);
  if (!token) throw new Error('CSRF token tidak ditemukan');
  return token;
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function stripTags(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}

function parseFormFields(html) {
  const fields = {};
  const inputRegex = /<(input|select|textarea)\b([^>]*)>([\s\S]*?)(?:<\/\1>)?/gi;
  let match;

  while ((match = inputRegex.exec(html))) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const name = attrs.match(/\bname="([^"]+)"/)?.[1];
    if (!name || name.startsWith('f_')) continue;

    if (tag === 'select') {
      const selected = match[0].match(/<option([^>]*)selected([^>]*)>([\s\S]*?)<\/option>/i);
      const first = match[0].match(/<option([^>]*)>([\s\S]*?)<\/option>/i);
      const source = selected || first;
      const optionAttrs = source ? `${source[1] || ''} ${source[2] || ''}` : '';
      fields[name] = optionAttrs.match(/value="([^"]*)"/)?.[1] || '';
      continue;
    }

    if (tag === 'textarea') {
      fields[name] = stripTags(match[3] || '');
      continue;
    }

    const type = attrs.match(/\btype="([^"]+)"/)?.[1]?.toLowerCase() || 'text';
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(attrs)) continue;
    fields[name] = decodeHtml(attrs.match(/\bvalue="([^"]*)"/)?.[1] || '');
  }

  return fields;
}

function parseModal(html) {
  const csrfToken = extractCsrf(html);
  const locations = [];
  const selectMatch = html.match(/<select[^>]+id="location"[\s\S]*?<\/select>/i);

  if (selectMatch) {
    const optionRegex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(selectMatch[0]))) {
      const attrs = match[1];
      const value = attrs.match(/value="([^"]*)"/)?.[1] || '';
      if (!value) continue;
      locations.push({
        id: value,
        name: stripTags(match[2]),
        isRadius: attrs.match(/data-is-radius="([^"]*)"/)?.[1] ?? '',
        selected: /selected/i.test(attrs),
      });
    }
  }

  return {
    csrfToken,
    fields: parseFormFields(html),
    locations,
    workFromTypes: [...html.matchAll(/<option\s+value="([^"]+)">([\s\S]*?)<\/option>/gi)]
      .map((match) => ({ value: match[1], label: stripTags(match[2]) }))
      .filter((item) => ['office', 'home', 'other'].includes(item.value)),
    lastAttendanceId: html.match(/id="last_attendance_id"[^>]+value="([^"]*)"/)?.[1] || '',
    lastAttendanceDate: html.match(/id="last_attendance_date"[^>]+value="([^"]*)"/)?.[1] || '',
    requiresFixClockOut: html.includes('id="last_attendance_id"'),
    rawTimeLabel: stripTags(html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || ''),
  };
}

function extractActivityTime(html, label) {
  const regex = new RegExp(`<p[^>]*>\\s*${label}[\\s\\S]*?<\\/p>\\s*<p[^>]*class="res-activity-time"[^>]*>([\\s\\S]*?)<\\/p>`, 'i');
  const value = stripTags(html.match(regex)?.[1] || '').replace(/^\s*/, '').replace(/\s+/g, ' ').trim();
  return value.match(/\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}/)?.[0] || value;
}

function parseClockOutModal(html) {
  return {
    fields: parseFormFields(html),
    requiresPhoto: html.includes('id="imageBase64"') || html.includes('name="imageBase64"'),
    rawTitle: stripTags(html.match(/<h5[^>]*id="modelHeading"[^>]*>([\s\S]*?)<\/h5>/i)?.[1] || 'Clock Out'),
    attendanceDate: stripTags(html.match(/Date\s*-\s*([\s\S]*?)<\/h4>/i)?.[1] || ''),
    clockInAt: extractActivityTime(html, 'Clock In'),
    clockOutAt: extractActivityTime(html, 'Clock Out'),
  };
}

function parseDashboardStatus(html) {
  const clockBlock = html.match(/<span[^>]+id="dashboard-clock"[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
  const clock = stripTags(clockBlock?.[1] || '');
  const day = stripTags(clockBlock?.[2] || '');
  const hasClockOut = html.includes('id="clock-out"');
  const hasClockIn = html.includes('id="clock-in"');
  const clockOutOptions = parseClockOutOptionsFromDashboard(html);

  return {
    dashboardClock: clock,
    dashboardDay: day,
    attendanceStatus: hasClockOut ? 'clocked_in' : hasClockIn ? 'not_clocked_in' : 'unknown',
    attendanceStatusLabel: hasClockOut ? 'Clocked In' : hasClockIn ? 'Not Clocked In' : 'Unknown',
    canClockIn: hasClockIn,
    canClockOut: hasClockOut,
    attendanceId: clockOutOptions.attendanceId,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

const DEFAULT_SETTINGS = {
  defaultLocationId: '1',
  workingFrom: '',
  officeLatitude: DEFAULT_LATITUDE,
  officeLongitude: DEFAULT_LONGITUDE,
  officeName: 'PT Minergo Visi Maxima',
};

async function readSettings() {
  const saved = await readState('settings');
  if (saved) return { ...DEFAULT_SETTINGS, ...saved };
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };

  const migrated = { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) };
  await writeState('settings', migrated);
  return migrated;
}

async function saveSettings(settings) {
  const current = await readSettings();
  const safe = {
    ...current,
    defaultLocationId: String(settings.defaultLocationId || ''),
    workingFrom: String(settings.workingFrom || ''),
    officeLatitude: String(settings.officeLatitude || current.officeLatitude || ''),
    officeLongitude: String(settings.officeLongitude || current.officeLongitude || ''),
    officeName: String(settings.officeName || current.officeName || ''),
  };
  await writeState('settings', safe);
  return safe;
}

async function login({ email, password }) {
  await loadSession();
  jar.clear();
  const page = await hrisFetch('/login', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    },
  });
  const html = await page.text();
  const token = extractCsrf(html);

  const body = new URLSearchParams({
    _token: token,
    email,
    password,
    locale: 'en',
    current_latitude: '',
    current_longitude: '',
    g_recaptcha: '',
  });

  const response = await hrisFetch('/login', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });

  const payload = await readResponsePayload(response, 500);

  if (isFailedPayload(response, payload)) {
    await clearSession();
    throw new Error(payload.message || payload.error || 'Login gagal');
  }
  await saveSession();
  return payload;
}

async function getDashboardHtml() {
  const response = await hrisFetch('/account/dashboard', {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    },
  });
  const html = await response.text();
  if (!response.ok || html.includes('id="login-form"') || html.includes('name="email"') || html.includes('id="password"')) {
    await clearSession();
    throw new Error('Session HRIS habis, silakan login ulang');
  }
  extractCsrfLoose(html);
  return html;
}

function parseClockOutOptionsFromDashboard(html) {
  const hasClockOut = html.includes('id="clock-out"');
  const updateBlock = html.match(/function\s+clockOut\s*\(\)\s*{[\s\S]*?update-clock-in[\s\S]*?success\s*:/i)?.[0] || '';
  const csrfToken = updateBlock.match(/var\s+token\s*=\s*"([^"]+)"/)?.[1]
    || html.match(/"csrfToken":"([^"]+)"/)?.[1]
    || lastCsrfToken;
  const attendanceId = updateBlock.match(/id:\s*'([^']+)'/)?.[1]
    || updateBlock.match(/id:\s*"([^"]+)"/)?.[1]
    || '';

  return {
    canClockOut: hasClockOut && Boolean(attendanceId),
    attendanceId,
    csrfToken,
  };
}

async function getClockInModal() {
  const response = await hrisFetch('/account/attendances/clock-in-modal', {
    headers: {
      Accept: 'text/html, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      Referer: `${BASE_URL}/account/dashboard`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const html = await response.text();
  if (html.includes('id="login-form"')) {
    await clearSession();
    throw new Error('Session HRIS habis, silakan login ulang');
  }
  return parseModal(html);
}

async function getSessionStatus() {
  await loadSession();
  if (jar.size === 0) return { loggedIn: false };

  try {
    await getDashboardHtml();
    return { loggedIn: true };
  } catch (error) {
    if (error.message.includes('Session HRIS habis')) return { loggedIn: false };
    throw error;
  }
}

async function getClockOutOptions() {
  const html = await getDashboardHtml();
  const options = parseClockOutOptionsFromDashboard(html);

  if (options.canClockOut) {
    const modalResponse = await hrisFetch(`/account/attendances/show_clocked_hours?aid=${encodeURIComponent(options.attendanceId)}`, {
      headers: {
        Accept: 'text/html, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        Referer: `${BASE_URL}/account/dashboard`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    const modalHtml = await modalResponse.text();
    return { ...options, ...parseClockOutModal(modalHtml) };
  }

  return options;
}

async function getDashboardStatus() {
  const html = await getDashboardHtml();
  const status = parseDashboardStatus(html);

  if (status.canClockOut && status.attendanceId) {
    const details = await getClockOutOptions();
    return {
      ...status,
      attendanceDate: details.attendanceDate || '',
      clockInAt: details.clockInAt || '',
      clockOutAt: details.clockOutAt || '',
    };
  }

  return {
    ...status,
    attendanceDate: '',
    clockInAt: '',
    clockOutAt: '',
  };
}

async function storeClockIn(input) {
  const settings = await readSettings();
  const modal = input.csrfToken ? null : await getClockInModal();
  const token = input.csrfToken || modal.csrfToken || lastCsrfToken;
  const location = String(input.location || settings.defaultLocationId || modal?.locations?.find((item) => item.selected)?.id || '');
  const currentLatitude = String(input.currentLatitude || settings.officeLatitude || DEFAULT_LATITUDE);
  const currentLongitude = String(input.currentLongitude || settings.officeLongitude || DEFAULT_LONGITUDE);
  const imageBase64 = String(input.imageBase64 || '');

  if (!location) throw new Error('Location belum dipilih');
  if (!currentLatitude || !currentLongitude) throw new Error('Latitude/longitude belum tersedia');
  if (!imageBase64.startsWith('data:image/')) throw new Error('Foto webcam wajib dalam format data:image/...;base64');

  const body = new URLSearchParams({
    working_from: String(input.working_from || settings.workingFrom || ''),
    location,
    work_from_type: String(input.work_from_type || 'office'),
    currentLatitude,
    currentLongitude,
    imageBase64,
    fix_clock_out_time: String(input.fix_clock_out_time || ''),
    fix_clock_out_note: String(input.fix_clock_out_note || ''),
    last_attendance_id: String(input.last_attendance_id || modal?.lastAttendanceId || ''),
    last_attendance_date: String(input.last_attendance_date || modal?.lastAttendanceDate || ''),
    _token: token,
  });

  const response = await hrisFetch('/account/attendances/store-clock-in', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/account/dashboard`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });

  const payload = await readResponsePayload(response);

  if (isFailedPayload(response, payload)) {
    throw new Error(payload.message || payload.error || 'Clock-in gagal');
  }
  return payload;
}

async function storeClockOut(input) {
  const options = input.attendanceId && input.csrfToken ? null : await getClockOutOptions();
  const attendanceId = String(input.attendanceId || options?.attendanceId || '');
  const token = String(input.csrfToken || options?.csrfToken || lastCsrfToken || '');
  const currentLatitude = String(input.currentLatitude || DEFAULT_LATITUDE);
  const currentLongitude = String(input.currentLongitude || DEFAULT_LONGITUDE);

  if (!attendanceId) throw new Error('Attendance ID clock-out tidak ditemukan. Pastikan akun sedang clock-in.');
  if (!token) throw new Error('CSRF token clock-out tidak ditemukan.');
  if (!currentLatitude || !currentLongitude) throw new Error('Latitude/longitude belum tersedia');

  const qs = new URLSearchParams({
    currentLatitude,
    currentLongitude,
    _token: token,
    id: attendanceId,
  });

  const response = await hrisFetch(`/account/attendances/update-clock-in?${qs.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      Referer: `${BASE_URL}/account/dashboard`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  const payload = await readResponsePayload(response);

  if (isFailedPayload(response, payload)) {
    throw new Error(payload.message || payload.error || 'Clock-out gagal');
  }
  return payload;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return text(res, 403, 'Forbidden');

  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    text(res, 200, buffer, types[ext] || 'application/octet-stream');
  } catch {
    text(res, 404, 'Not found');
  }
}

async function route(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const payload = await readJson(req);
      return json(res, 200, await login(payload));
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      return json(res, 200, await getSessionStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/clock-in-options') {
      const [settings, options] = await Promise.all([readSettings(), getClockInModal()]);
      return json(res, 200, { ...options, settings });
    }

    if (req.method === 'GET' && url.pathname === '/api/clock-out-options') {
      return json(res, 200, await getClockOutOptions());
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard-status') {
      return json(res, 200, await getDashboardStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return json(res, 200, await readSettings());
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      return json(res, 200, await saveSettings(await readJson(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/clock-in') {
      return json(res, 200, await storeClockIn(await readJson(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/clock-out') {
      return json(res, 200, await storeClockOut(await readJson(req)));
    }

    return serveStatic(req, res);
  } catch (error) {
    return json(res, 400, { status: 'error', message: error.message });
  }
}

const port = Number(process.env.PORT || 3000);
createServer(route).listen(port, () => {
  console.log(`HRIS Clock-In Helper running at http://localhost:${port}`);
});

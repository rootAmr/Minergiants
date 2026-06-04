import { randomBytes } from 'node:crypto';
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
const MAX_SAVED_PHOTOS = 30;
const MAX_JSON_BODY_BYTES = 6 * 1024 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const APP_CSRF_TOKEN = randomBytes(24).toString('hex');

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
    );

    CREATE TABLE IF NOT EXISTS saved_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      image_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT
    )
  `);
  return db;
}

async function readState(key) {
  const database = await getDb();
  const row = database.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
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

function photoSummary(row) {
  return {
    id: row.id,
    label: row.label,
    imageBase64: row.image_base64,
    createdAt: row.created_at,
    usedAt: row.used_at,
  };
}

async function listPhotos() {
  const database = await getDb();
  return database.prepare(`
    SELECT id, label, image_base64, created_at, used_at
    FROM saved_photos
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(MAX_SAVED_PHOTOS).map(photoSummary);
}

async function getPhoto(id) {
  const photoId = Number(id);
  if (!Number.isInteger(photoId) || photoId <= 0) return null;
  const database = await getDb();
  const row = database.prepare(`
    SELECT id, label, image_base64, created_at, used_at
    FROM saved_photos
    WHERE id = ?
  `).get(photoId);
  return row ? photoSummary(row) : null;
}

async function savePhoto(input) {
  const imageBase64 = String(input.imageBase64 || '');
  validatePhotoDataUrl(imageBase64);

  const label = String(input.label || '').trim() || `Foto ${new Date().toLocaleString('id-ID')}`;
  const database = await getDb();
  const result = database.prepare(`
    INSERT INTO saved_photos (label, image_base64, created_at, used_at)
    VALUES (?, ?, ?, NULL)
  `).run(label.slice(0, 120), imageBase64, new Date().toISOString());

  database.prepare(`
    DELETE FROM saved_photos
    WHERE id NOT IN (
      SELECT id FROM saved_photos
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    )
  `).run(MAX_SAVED_PHOTOS);

  return getPhoto(result.lastInsertRowid);
}

async function deletePhoto(id) {
  const photoId = Number(id);
  if (!Number.isInteger(photoId) || photoId <= 0) throw new Error('Photo ID tidak valid');
  const database = await getDb();
  const result = database.prepare('DELETE FROM saved_photos WHERE id = ?').run(photoId);
  return { deleted: result.changes > 0 };
}

async function markPhotoUsed(id) {
  const photoId = Number(id);
  if (!Number.isInteger(photoId) || photoId <= 0) return;
  const database = await getDb();
  database.prepare('UPDATE saved_photos SET used_at = ? WHERE id = ?').run(new Date().toISOString(), photoId);
}

function estimateDataUrlBytes(value) {
  const base64 = String(value || '').split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

function validatePhotoDataUrl(imageBase64) {
  if (!imageBase64.startsWith('data:image/')) throw new Error('Foto wajib dalam format data:image/...;base64');
  if (estimateDataUrlBytes(imageBase64) > MAX_PHOTO_BYTES) throw new Error('Ukuran foto terlalu besar. Maksimal 4 MB per foto.');
}

function isLocalHostname(value) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(value || '').toLowerCase());
}

function hostnameFromHostHeader(value) {
  const host = String(value || '').toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return host.split(':')[0];
}

function isAllowedLocalRequest(req) {
  if (!isLocalHostname(hostnameFromHostHeader(req.headers.host))) return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function requireAppCsrf(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const token = req.headers['x-app-csrf-token'];
  if (token !== APP_CSRF_TOKEN) throw new Error('Token aplikasi tidak valid. Refresh halaman lalu coba lagi.');
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

function isLoginRedirect(response) {
  const location = response.headers.get('location') || '';
  return response.status >= 300 && response.status < 400 && /\/login(?:$|[?#])/i.test(location);
}

function isLoginPageHtml(html) {
  return /id=["']login-form["']/i.test(html)
    || /<form\b[^>]*action=["'][^"']*\/login[^"']*["'][^>]*>/i.test(html);
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

function readHtmlAttr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function parseFormFields(html) {
  const fields = {};
  const shouldSkip = (name) => !name || name.startsWith('f_');

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let match;
  while ((match = selectRegex.exec(html))) {
    const name = readHtmlAttr(match[1], 'name');
    if (shouldSkip(name)) continue;

    const options = [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const selected = options.find((option) => /\bselected\b/i.test(option[1]));
    const option = selected || options[0];
    fields[name] = option ? readHtmlAttr(option[1], 'value') || stripTags(option[2] || '') : '';
  }

  const textareaRegex = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((match = textareaRegex.exec(html))) {
    const name = readHtmlAttr(match[1], 'name');
    if (!shouldSkip(name)) fields[name] = stripTags(match[2] || '');
  }

  const inputRegex = /<input\b([^>]*)>/gi;
  while ((match = inputRegex.exec(html))) {
    const attrs = match[1];
    const name = readHtmlAttr(attrs, 'name');
    if (shouldSkip(name)) continue;

    const type = readHtmlAttr(attrs, 'type').toLowerCase() || 'text';
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(attrs)) continue;
    fields[name] = readHtmlAttr(attrs, 'value');
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
  if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
    throw new Error('Content-Type wajib application/json');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) throw new Error('Request terlalu besar. Maksimal 6 MB.');
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Body JSON tidak valid');
  }
}

function normalizeTimeSetting(value, fallback) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const DEFAULT_SETTINGS = {
  defaultLocationId: '1',
  workingFrom: '',
  officeLatitude: DEFAULT_LATITUDE,
  officeLongitude: DEFAULT_LONGITUDE,
  officeName: 'PT Minergo Visi Maxima',
  scheduleEnabled: false,
  checkInTime: '09:00',
  checkOutTime: '18:00',
  randomCheckInEnabled: false,
  randomCheckOutEnabled: false,
  randomPhotoEnabled: false,
  selectedPhotoId: '',
  checkInStartTime: '08:45',
  checkInEndTime: '09:00',
  checkOutStartTime: '17:45',
  checkOutEndTime: '18:15',
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
    defaultLocationId: Object.hasOwn(settings, 'defaultLocationId') ? String(settings.defaultLocationId || '') : current.defaultLocationId,
    workingFrom: Object.hasOwn(settings, 'workingFrom') ? String(settings.workingFrom || '') : current.workingFrom,
    officeLatitude: Object.hasOwn(settings, 'officeLatitude') ? String(settings.officeLatitude || current.officeLatitude || '') : current.officeLatitude,
    officeLongitude: Object.hasOwn(settings, 'officeLongitude') ? String(settings.officeLongitude || current.officeLongitude || '') : current.officeLongitude,
    officeName: Object.hasOwn(settings, 'officeName') ? String(settings.officeName || current.officeName || '') : current.officeName,
    scheduleEnabled: Object.hasOwn(settings, 'scheduleEnabled') ? Boolean(settings.scheduleEnabled) : Boolean(current.scheduleEnabled),
    checkInTime: Object.hasOwn(settings, 'checkInTime') ? normalizeTimeSetting(settings.checkInTime, '09:00') : current.checkInTime,
    checkOutTime: Object.hasOwn(settings, 'checkOutTime') ? normalizeTimeSetting(settings.checkOutTime, '18:00') : current.checkOutTime,
    randomCheckInEnabled: Object.hasOwn(settings, 'randomCheckInEnabled') ? Boolean(settings.randomCheckInEnabled) : Boolean(current.randomCheckInEnabled),
    randomCheckOutEnabled: Object.hasOwn(settings, 'randomCheckOutEnabled') ? Boolean(settings.randomCheckOutEnabled) : Boolean(current.randomCheckOutEnabled),
    randomPhotoEnabled: Object.hasOwn(settings, 'randomPhotoEnabled') ? Boolean(settings.randomPhotoEnabled) : Boolean(current.randomPhotoEnabled),
    selectedPhotoId: Object.hasOwn(settings, 'selectedPhotoId') ? String(settings.selectedPhotoId || '') : current.selectedPhotoId,
    checkInStartTime: Object.hasOwn(settings, 'checkInStartTime') ? normalizeTimeSetting(settings.checkInStartTime, '08:45') : current.checkInStartTime,
    checkInEndTime: Object.hasOwn(settings, 'checkInEndTime') ? normalizeTimeSetting(settings.checkInEndTime, '09:00') : current.checkInEndTime,
    checkOutStartTime: Object.hasOwn(settings, 'checkOutStartTime') ? normalizeTimeSetting(settings.checkOutStartTime, '17:45') : current.checkOutStartTime,
    checkOutEndTime: Object.hasOwn(settings, 'checkOutEndTime') ? normalizeTimeSetting(settings.checkOutEndTime, '18:15') : current.checkOutEndTime,
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
  await getDashboardHtml();
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
  if (isLoginRedirect(response) || isLoginPageHtml(html)) {
    await clearSession();
    throw new Error('Session HRIS habis, silakan login ulang');
  }
  if (!response.ok) throw new Error(`Dashboard HRIS gagal dimuat (${response.status})`);
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
  if (isLoginRedirect(response) || isLoginPageHtml(html)) {
    await clearSession();
    throw new Error('Session HRIS habis, silakan login ulang');
  }
  if (!response.ok) throw new Error(`Modal clock-in HRIS gagal dimuat (${response.status})`);
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
  const token = String(input.csrfToken || modal?.csrfToken || lastCsrfToken || '');
  const location = String(input.location || settings.defaultLocationId || modal?.locations?.find((item) => item.selected)?.id || '');
  const currentLatitude = String(input.currentLatitude || settings.officeLatitude || DEFAULT_LATITUDE);
  const currentLongitude = String(input.currentLongitude || settings.officeLongitude || DEFAULT_LONGITUDE);
  const selectedPhoto = input.photoId ? await getPhoto(input.photoId) : null;
  const imageBase64 = String(input.imageBase64 || selectedPhoto?.imageBase64 || '');

  if (!token) throw new Error('CSRF token clock-in tidak ditemukan. Refresh data lalu coba lagi.');
  if (input.photoId && !selectedPhoto) throw new Error('Foto tersimpan tidak ditemukan');
  if (!location) throw new Error('Location belum dipilih');
  if (!currentLatitude || !currentLongitude) throw new Error('Latitude/longitude belum tersedia');
  validatePhotoDataUrl(imageBase64);

  const body = new URLSearchParams(modal?.fields || {});
  body.set('working_from', String(input.working_from || settings.workingFrom || ''));
  body.set('location', location);
  body.set('work_from_type', String(input.work_from_type || 'office'));
  body.set('currentLatitude', currentLatitude);
  body.set('currentLongitude', currentLongitude);
  body.set('imageBase64', imageBase64);
  body.set('fix_clock_out_time', String(input.fix_clock_out_time || ''));
  body.set('fix_clock_out_note', String(input.fix_clock_out_note || ''));
  body.set('last_attendance_id', String(input.last_attendance_id || modal?.lastAttendanceId || ''));
  body.set('last_attendance_date', String(input.last_attendance_date || modal?.lastAttendanceDate || ''));
  body.set('_token', token);

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
  if (selectedPhoto) await markPhotoUsed(selectedPhoto.id);
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

    if (url.pathname.startsWith('/api/') && !isAllowedLocalRequest(req)) {
      return json(res, 403, { status: 'error', message: 'API lokal hanya menerima request dari localhost.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      return json(res, 200, { appCsrfToken: APP_CSRF_TOKEN });
    }

    if (url.pathname.startsWith('/api/')) requireAppCsrf(req);

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const payload = await readJson(req);
      return json(res, 200, await login(payload));
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      return json(res, 200, await getSessionStatus());
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      await clearSession();
      return json(res, 200, { loggedIn: false, message: 'Logout sukses' });
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

    if (req.method === 'GET' && url.pathname === '/api/photos') {
      return json(res, 200, { photos: await listPhotos() });
    }

    if (req.method === 'POST' && url.pathname === '/api/photos') {
      return json(res, 200, await savePhoto(await readJson(req)));
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/photos/')) {
      return json(res, 200, await deletePhoto(url.pathname.split('/').pop()));
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
const server = createServer(route);
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} sudah dipakai. Jalankan dengan PORT lain, contoh: PORT=3100 npm start`);
    process.exit(1);
  }
  throw error;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`HRIS Clock-In Helper running at http://127.0.0.1:${port}`);
});

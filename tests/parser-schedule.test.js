import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadServerFormParser() {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function decodeHtml');
  const end = source.indexOf('function parseModal');
  assert.notEqual(start, -1, 'decodeHtml function not found');
  assert.notEqual(end, -1, 'parseModal function not found');

  return new Function(`${source.slice(start, end)}\nreturn { parseFormFields };`)();
}

async function loadScheduleHelpers() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function normalizeTime');
  const end = source.indexOf('async function saveScheduleSettings');
  assert.notEqual(start, -1, 'normalizeTime function not found');
  assert.notEqual(end, -1, 'saveScheduleSettings function not found');

  return new Function(`
    function getUserStorage(key) { return localStorage.getItem(key); }
    function setUserStorage(key, value) { localStorage.setItem(key, value); }
    ${source.slice(start, end)}
    return { normalizeTime, minutesFromTime, timeFromMinutes, dailyRandomTarget };
  `)();
}

async function loadScheduleDueHelper() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const match = source.match(/function isScheduleDue\([\s\S]*?\n}/);
  assert.ok(match, 'isScheduleDue function not found');

  return new Function(`
    function normalizeTime(value, fallback) {
      const match = String(value || '').match(/^(\\d{1,2}):(\\d{2})$/);
      const hour = match ? Number(match[1]) : NaN;
      const minute = match ? Number(match[2]) : NaN;
      if (!match || hour > 23 || minute > 59) return fallback;
      return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    }
    function minutesFromTime(value, fallback) {
      const normalized = normalizeTime(value, fallback || '00:00');
      const [hour, minute] = normalized.split(':').map(Number);
      return hour * 60 + minute;
    }
    ${match[0]}
    return { isScheduleDue };
  `)();
}

async function loadCoordinateHelpers() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const DEFAULT_COORDS');
  const end = source.indexOf('const state =');
  assert.notEqual(start, -1, 'DEFAULT_COORDS not found');
  assert.notEqual(end, -1, 'state declaration not found');

  return new Function(`${source.slice(start, end)}\nreturn { randomCoordinateInRange, DEFAULT_COORD_RADIUS_METERS };`)();
}

function distanceMeters(a, b) {
  const earthRadius = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const deltaLatitude = toRadians(b.latitude - a.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
}

test('parseFormFields reads HRIS modal fields flexibly', async () => {
  const { parseFormFields } = await loadServerFormParser();
  const html = `
    <form>
      <input type="hidden" name="_token" value="tok&amp;1">
      <input type=checkbox name=unchecked value=no>
      <input type='checkbox' name='checkedBox' value='yes' checked>
      <input name="f_email" value="skipme">
      <select name="location">
        <option value="1">Minergo HO Balikpapan</option>
        <option selected value='20'>Lokasi Lainnya</option>
      </select>
      <select name='work_from_type'><option value=office>Office</option></select>
      <textarea name="note">Lupa <b>clock out</b></textarea>
    </form>
  `;

  assert.deepEqual(parseFormFields(html), {
    _token: 'tok&1',
    checkedBox: 'yes',
    location: '20',
    work_from_type: 'office',
    note: 'Lupa clock out',
  });
});

test('parseFormFields supports fix clock-out fields from HRIS', async () => {
  const { parseFormFields } = await loadServerFormParser();
  const html = `
    <input type="text" name="fix_clock_out_time" id="fix_clock_out_time">
    <input type="text" name="fix_clock_out_note" id="fix_clock_out_note" value="Lupa clock out">
    <input type="hidden" name="last_attendance_id" id="last_attendance_id" value="215">
    <input type="hidden" name="last_attendance_date" id="last_attendance_date" value="2026-05-20">
  `;

  assert.deepEqual(parseFormFields(html), {
    fix_clock_out_time: '',
    fix_clock_out_note: 'Lupa clock out',
    last_attendance_id: '215',
    last_attendance_date: '2026-05-20',
  });
});

test('default coordinate helper stays within 5 meters of office coordinate', async () => {
  const { randomCoordinateInRange, DEFAULT_COORD_RADIUS_METERS } = await loadCoordinateHelpers();
  const base = { latitude: -1.228552, longitude: 116.881761 };
  const values = [1, 0];
  const coords = randomCoordinateInRange(base.latitude, base.longitude, DEFAULT_COORD_RADIUS_METERS, () => values.shift() ?? 0);

  assert.notDeepEqual({ latitude: coords.latitude, longitude: coords.longitude }, base);
  assert.ok(distanceMeters(base, coords) <= DEFAULT_COORD_RADIUS_METERS + 0.05);
  assert.equal(coords.source, 'default');
  assert.equal(coords.accuracy, DEFAULT_COORD_RADIUS_METERS);
});

test('schedule helpers normalize and compare time safely', async () => {
  const { normalizeTime, minutesFromTime, timeFromMinutes } = await loadScheduleHelpers();
  const { isScheduleDue } = await loadScheduleDueHelper();

  assert.equal(normalizeTime('7:05', '09:00'), '07:05');
  assert.equal(normalizeTime('99:99', '09:00'), '09:00');
  assert.equal(minutesFromTime('01:30'), 90);
  assert.equal(timeFromMinutes(1439), '23:59');
  assert.equal(timeFromMinutes(9999), '23:59');
  assert.equal(isScheduleDue('09:00', '09:00'), true);
  assert.equal(isScheduleDue('09:01', '09:00'), true);
  assert.equal(isScheduleDue('09:02', '09:00'), false);
});

test('dailyRandomTarget stays inside configured range and is stable for same day', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  };

  const { dailyRandomTarget, minutesFromTime } = await loadScheduleHelpers();
  const first = dailyRandomTarget('clock-in', '08:45', '09:00');
  const second = dailyRandomTarget('clock-in', '08:45', '09:00');

  assert.match(first, /^\d{2}:\d{2}$/);
  assert.equal(second, first);
  assert.ok(minutesFromTime(first) >= minutesFromTime('08:45'));
  assert.ok(minutesFromTime(first) <= minutesFromTime('09:00'));
});

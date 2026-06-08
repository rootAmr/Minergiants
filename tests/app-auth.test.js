import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const repoDir = path.resolve(new URL('..', import.meta.url).pathname);

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('server did not start');
}

async function request(baseUrl, urlPath, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers['X-App-CSRF-Token'] = options.csrf;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  return {
    response,
    payload,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
  };
}

test('app auth enforces CSRF and isolates settings, photos, and HRIS sessions', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hris-helper-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoDir,
    env: {
      ...process.env,
      APP_DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2000)]);
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child);

  const bootstrap = await request(baseUrl, '/api/bootstrap');
  assert.equal(bootstrap.payload.setupRequired, true);
  assert.equal(bootstrap.payload.authenticated, false);

  const setup = await request(baseUrl, '/api/app/setup', {
    method: 'POST',
    body: { username: 'admin', password: 'password123', displayName: 'Admin' },
  });
  assert.equal(setup.response.status, 200);
  assert.ok(setup.cookie);
  assert.ok(setup.payload.appCsrfToken);
  assert.equal(setup.payload.appUser.username, 'admin');
  assert.equal(setup.payload.appUser.whatsappPhoneNumber, '');

  const secondSetup = await request(baseUrl, '/api/app/setup', {
    method: 'POST',
    body: { username: 'other', password: 'password123' },
  });
  assert.equal(secondSetup.response.status, 409);

  const noProfileCsrf = await request(baseUrl, '/api/app/profile', {
    method: 'POST',
    cookie: setup.cookie,
    body: { whatsappPhoneNumber: '+62 812-3456-789' },
  });
  assert.equal(noProfileCsrf.response.status, 403);

  const profile = await request(baseUrl, '/api/app/profile', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: { whatsappPhoneNumber: '+62 812-3456-789' },
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.payload.appUser.whatsappPhoneNumber, '628123456789');

  const noCsrf = await request(baseUrl, '/api/settings', {
    method: 'POST',
    cookie: setup.cookie,
    body: { workingFrom: 'admin-office' },
  });
  assert.equal(noCsrf.response.status, 403);

  const adminSettings = await request(baseUrl, '/api/settings', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: { workingFrom: 'admin-office' },
  });
  assert.equal(adminSettings.payload.workingFrom, 'admin-office');

  const usersBefore = await request(baseUrl, '/api/app/users', {
    cookie: setup.cookie,
  });
  assert.deepEqual(usersBefore.payload.users.map((item) => item.username), ['admin']);

  const noUserCsrf = await request(baseUrl, '/api/app/users', {
    method: 'POST',
    cookie: setup.cookie,
    body: {
      username: 'blocked',
      password: 'password123',
      whatsappPhoneNumber: '628199999999',
    },
  });
  assert.equal(noUserCsrf.response.status, 403);

  const createdSecondUser = await request(baseUrl, '/api/app/users', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: {
      username: 'second',
      password: 'password123',
      displayName: 'Second',
      whatsappPhoneNumber: '+62 811-0000-000',
    },
  });
  assert.equal(createdSecondUser.response.status, 200);
  assert.equal(createdSecondUser.payload.appUser.whatsappPhoneNumber, '628110000000');
  assert.deepEqual(createdSecondUser.payload.users.map((item) => item.username), ['admin', 'second']);

  const duplicateManagedPhone = await request(baseUrl, '/api/app/users', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: {
      username: 'third',
      password: 'password123',
      whatsappPhoneNumber: '628123456789',
    },
  });
  assert.equal(duplicateManagedPhone.response.status, 409);

  const secondLogin = await request(baseUrl, '/api/app/login', {
    method: 'POST',
    body: { username: 'second', password: 'password123' },
  });
  assert.equal(secondLogin.response.status, 200);
  const secondCookie = secondLogin.cookie;
  const secondCsrf = secondLogin.payload.appCsrfToken;
  const secondUserId = secondLogin.payload.appUser.id;

  const nonAdminUsers = await request(baseUrl, '/api/app/users', {
    cookie: secondCookie,
  });
  assert.equal(nonAdminUsers.response.status, 403);

  const duplicatePhone = await request(baseUrl, '/api/app/profile', {
    method: 'POST',
    cookie: secondCookie,
    csrf: secondCsrf,
    body: { whatsappPhoneNumber: '628123456789' },
  });
  assert.equal(duplicatePhone.response.status, 409);

  const secondSettings = await request(baseUrl, '/api/settings', { cookie: secondCookie });
  assert.equal(secondSettings.payload.workingFrom, '');

  const database = new DatabaseSync(path.join(dataDir, 'app.db'));
  const now = new Date().toISOString();

  const photo = await request(baseUrl, '/api/photos', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: { label: 'Admin photo', imageBase64: 'data:image/png;base64,iVBORw0KGgo=' },
  });
  assert.equal(photo.response.status, 200);

  const secondPhotos = await request(baseUrl, '/api/photos', { cookie: secondCookie });
  assert.deepEqual(secondPhotos.payload.photos, []);

  const deleteOtherPhoto = await request(baseUrl, `/api/photos/${photo.payload.id}`, {
    method: 'DELETE',
    cookie: secondCookie,
    csrf: secondCsrf,
  });
  assert.equal(deleteOtherPhoto.payload.deleted, false);

  database.prepare(`
    INSERT OR REPLACE INTO hris_sessions (user_id, cookies_json, last_csrf_token, saved_at)
    VALUES (?, '{"admin":"1"}', 'admin-token', ?)
  `).run(setup.payload.appUser.id, now);
  database.prepare(`
    INSERT OR REPLACE INTO hris_sessions (user_id, cookies_json, last_csrf_token, saved_at)
    VALUES (?, '{"second":"1"}', 'second-token', ?)
  `).run(secondUserId, now);

  const hrisLogout = await request(baseUrl, '/api/logout', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
  });
  assert.equal(hrisLogout.response.status, 200);

  const adminHris = database.prepare('SELECT cookies_json, last_csrf_token FROM hris_sessions WHERE user_id = ?').get(setup.payload.appUser.id);
  const secondHris = database.prepare('SELECT cookies_json, last_csrf_token FROM hris_sessions WHERE user_id = ?').get(secondUserId);
  assert.equal(adminHris.cookies_json, '{}');
  assert.equal(adminHris.last_csrf_token, '');
  assert.equal(secondHris.cookies_json, '{"second":"1"}');
  assert.equal(secondHris.last_csrf_token, 'second-token');

  database.close();
});

test('HRIS dev mode uses dummy responses without real HRIS calls', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hris-helper-dev-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoDir,
    env: {
      ...process.env,
      APP_DATA_DIR: dataDir,
      HRIS_DEV_MODE: 'true',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2000)]);
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child);

  const setup = await request(baseUrl, '/api/app/setup', {
    method: 'POST',
    body: { username: 'admin', password: 'password123', displayName: 'Admin' },
  });
  assert.equal(setup.response.status, 200);

  const login = await request(baseUrl, '/api/login', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: { email: 'dev@example.test', password: 'dummy-password' },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.devMode, true);

  const session = await request(baseUrl, '/api/session', {
    cookie: setup.cookie,
  });
  assert.equal(session.payload.loggedIn, true);

  const clockInOptions = await request(baseUrl, '/api/clock-in-options', {
    cookie: setup.cookie,
  });
  assert.equal(clockInOptions.payload.csrfToken, 'dev-csrf-token');
  assert.equal(clockInOptions.payload.locations[0].id, '1');

  const clockIn = await request(baseUrl, '/api/clock-in', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: { imageBase64: 'data:image/png;base64,iVBORw0KGgo=' },
  });
  assert.equal(clockIn.payload.devMode, true);

  const dashboard = await request(baseUrl, '/api/dashboard-status', {
    cookie: setup.cookie,
  });
  assert.equal(dashboard.payload.canClockOut, true);

  const clockOut = await request(baseUrl, '/api/clock-out', {
    method: 'POST',
    cookie: setup.cookie,
    csrf: setup.payload.appCsrfToken,
    body: {},
  });
  assert.equal(clockOut.payload.devMode, true);
});

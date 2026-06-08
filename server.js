import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WHATSAPP_SETTINGS,
  normalizeAuthorizedSenders,
  normalizeGroupJid,
  normalizeWhatsappPhone,
  resolveWhatsappPhoneUser,
  startWhatsappBot,
} from "./lib/whatsapp-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = "https://hris.minergosystems.com";
const HRIS_DEV_MODE = /^(1|true|yes|on)$/i.test(
  String(process.env.HRIS_DEV_MODE || process.env.APP_DEV_MODE || ""),
);
const DEV_CSRF_TOKEN = "dev-csrf-token";
const DEV_ATTENDANCE_ID = "dev-attendance-1";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const DEFAULT_LATITUDE = "-1.228552";
const DEFAULT_LONGITUDE = "116.881761";
const DEFAULT_COORD_RADIUS_METERS = 5;
const METERS_PER_DEGREE_LATITUDE = 111_320;
const MAX_SAVED_PHOTOS = 30;
const MAX_JSON_BODY_BYTES = 6 * 1024 * 1024;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const SESSION_COOKIE_NAME = "hris_app_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

let db = null;
let whatsappBot = null;
let whatsappBotStarting = null;
const hrisSessions = new Map();

function randomCoordinateInRange(
  latitude,
  longitude,
  radiusMeters = DEFAULT_COORD_RADIUS_METERS,
) {
  const baseLatitude = Number.isFinite(Number(latitude))
    ? Number(latitude)
    : Number(DEFAULT_LATITUDE);
  const baseLongitude = Number.isFinite(Number(longitude))
    ? Number(longitude)
    : Number(DEFAULT_LONGITUDE);
  const radius = Math.max(0, Number(radiusMeters) || 0);
  const distance = Math.sqrt(Math.random()) * radius;
  const angle = Math.random() * 2 * Math.PI;
  const latitudeOffset =
    (Math.cos(angle) * distance) / METERS_PER_DEGREE_LATITUDE;
  const longitudeScale =
    METERS_PER_DEGREE_LATITUDE *
    Math.max(0.01, Math.abs(Math.cos((baseLatitude * Math.PI) / 180)));
  const longitudeOffset = (Math.sin(angle) * distance) / longitudeScale;

  return {
    latitude: Number((baseLatitude + latitudeOffset).toFixed(7)),
    longitude: Number((baseLongitude + longitudeOffset).toFixed(7)),
  };
}

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

    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      whatsapp_phone_number TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hris_sessions (
      user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      cookies_json TEXT NOT NULL DEFAULT '{}',
      last_csrf_token TEXT NOT NULL DEFAULT '',
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_app_state (
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS saved_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      image_base64 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_saved_photos_user_created ON saved_photos(user_id, datetime(created_at) DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id);
  `);

  try {
    db.exec(
      "ALTER TABLE app_users ADD COLUMN whatsapp_phone_number TEXT NOT NULL DEFAULT ''",
    );
  } catch {}

  try {
    db.exec(
      "ALTER TABLE saved_photos ADD COLUMN user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE",
    );
  } catch {}

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_whatsapp_phone_unique ON app_users(whatsapp_phone_number) WHERE whatsapp_phone_number <> ''",
  );
  db.exec("PRAGMA user_version = 1");
  return db;
}

async function readState(key) {
  const database = await getDb();
  const row = database
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function writeState(key, value) {
  const database = await getDb();
  database
    .prepare(
      `
    INSERT INTO app_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `,
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [, salt, hash] = String(passwordHash || "").split(":");
  if (!salt || !hash) return false;
  const stored = Buffer.from(hash, "hex");
  const candidate = scryptSync(String(password), salt, stored.length);
  return (
    stored.length === candidate.length && timingSafeEqual(stored, candidate)
  );
}

function publicAppUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    whatsappPhoneNumber: row.whatsapp_phone_number || "",
    role: row.role,
  };
}

function requireAdmin(ctx) {
  if (ctx.user.role !== "admin") throw httpError(403, "Hanya admin yang bisa mengelola user.");
}

function normalizedProfilePhone(value) {
  const rawPhoneNumber = String(value || "");
  const whatsappPhoneNumber = normalizeWhatsappPhone(rawPhoneNumber);
  if (
    rawPhoneNumber.trim() &&
    (whatsappPhoneNumber.length < 8 || whatsappPhoneNumber.length > 16)
  ) {
    throw httpError(400, "Nomor WhatsApp harus 8-16 digit.");
  }
  return whatsappPhoneNumber;
}

function ensureUniqueWhatsappPhone(database, whatsappPhoneNumber, exceptUserId = 0) {
  if (!whatsappPhoneNumber) return;
  const duplicate = database
    .prepare("SELECT id FROM app_users WHERE whatsapp_phone_number = ? AND id <> ?")
    .get(whatsappPhoneNumber, exceptUserId);
  if (duplicate) throw httpError(409, "Nomor WhatsApp sudah dipakai user lain.");
}

async function appUserCount() {
  const database = await getDb();
  return database.prepare("SELECT COUNT(*) AS count FROM app_users").get()
    .count;
}

async function findAppUserByUsername(username) {
  const database = await getDb();
  return database
    .prepare(
      `
    SELECT id, username, password_hash, display_name, whatsapp_phone_number, role
    FROM app_users
    WHERE lower(username) = lower(?)
  `,
    )
    .get(String(username || "").trim());
}

async function claimLegacyDataForUser(userId) {
  const database = await getDb();
  const now = new Date().toISOString();
  const legacySettings = await readState("settings");
  if (legacySettings) {
    database
      .prepare(
        `
      INSERT OR IGNORE INTO user_settings (user_id, value, updated_at)
      VALUES (?, ?, ?)
    `,
      )
      .run(userId, JSON.stringify(legacySettings), now);
  } else if (existsSync(SETTINGS_FILE)) {
    try {
      const migrated = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
      database
        .prepare(
          `
        INSERT OR IGNORE INTO user_settings (user_id, value, updated_at)
        VALUES (?, ?, ?)
      `,
        )
        .run(userId, JSON.stringify(migrated), now);
    } catch {}
  }

  let legacySession = await readState("hris_session");
  if (!legacySession && existsSync(SESSION_FILE)) {
    try {
      legacySession = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    } catch {}
  }
  if (legacySession) {
    database
      .prepare(
        `
      INSERT OR IGNORE INTO hris_sessions (user_id, cookies_json, last_csrf_token, saved_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(
        userId,
        JSON.stringify(legacySession.cookies || {}),
        String(legacySession.lastCsrfToken || ""),
        legacySession.savedAt || now,
      );
  }

  const legacyBotState = await readState("whatsapp_bot_state");
  if (legacyBotState) {
    database
      .prepare(
        `
      INSERT OR IGNORE INTO user_app_state (user_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(userId, "whatsapp_bot_state", JSON.stringify(legacyBotState), now);
  }

  database
    .prepare("UPDATE saved_photos SET user_id = ? WHERE user_id IS NULL")
    .run(userId);
}

async function createFirstAdmin(input) {
  if ((await appUserCount()) > 0)
    throw httpError(409, "Setup aplikasi sudah selesai. Silakan login.");
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  const displayName = String(input.displayName || username).trim() || username;
  if (username.length < 3) throw httpError(400, "Username minimal 3 karakter.");
  if (password.length < 8)
    throw httpError(400, "Password aplikasi minimal 8 karakter.");

  const database = await getDb();
  const now = new Date().toISOString();
  const result = database
    .prepare(
      `
    INSERT INTO app_users (username, password_hash, display_name, role, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', ?, ?)
  `,
    )
    .run(username, hashPassword(password), displayName, now, now);
  await claimLegacyDataForUser(result.lastInsertRowid);
  return database
    .prepare(
      "SELECT id, username, display_name, whatsapp_phone_number, role FROM app_users WHERE id = ?",
    )
    .get(result.lastInsertRowid);
}

async function listManagedAppUsers(ctx) {
  requireAdmin(ctx);
  const database = await getDb();
  return database
    .prepare(
      "SELECT id, username, display_name, whatsapp_phone_number, role FROM app_users ORDER BY id",
    )
    .all()
    .map(publicAppUser);
}

async function createManagedAppUser(ctx, input) {
  requireAdmin(ctx);
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  const displayName = String(input.displayName || username).trim() || username;
  const whatsappPhoneNumber = normalizedProfilePhone(input.whatsappPhoneNumber);
  if (username.length < 3) throw httpError(400, "Username minimal 3 karakter.");
  if (password.length < 8)
    throw httpError(400, "Password aplikasi minimal 8 karakter.");

  const database = await getDb();
  const existing = database
    .prepare("SELECT id FROM app_users WHERE lower(username) = lower(?)")
    .get(username);
  if (existing) throw httpError(409, "Username aplikasi sudah dipakai.");
  ensureUniqueWhatsappPhone(database, whatsappPhoneNumber);

  const now = new Date().toISOString();
  const result = database
    .prepare(
      `
    INSERT INTO app_users (username, password_hash, display_name, whatsapp_phone_number, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'user', ?, ?)
  `,
    )
    .run(username, hashPassword(password), displayName, whatsappPhoneNumber, now, now);
  return publicAppUser(
    database
      .prepare(
        "SELECT id, username, display_name, whatsapp_phone_number, role FROM app_users WHERE id = ?",
      )
      .get(result.lastInsertRowid),
  );
}

async function updateAppProfile(ctx, input) {
  const hasDisplayName = Object.hasOwn(input, "displayName");
  const hasPhoneNumber = Object.hasOwn(input, "whatsappPhoneNumber");
  const displayName = hasDisplayName
    ? String(input.displayName || ctx.user.username).trim() || ctx.user.username
    : ctx.user.displayName || ctx.user.username;
  const rawPhoneNumber = hasPhoneNumber
    ? input.whatsappPhoneNumber
    : ctx.user.whatsappPhoneNumber || "";
  const whatsappPhoneNumber = normalizedProfilePhone(rawPhoneNumber);

  const database = await getDb();
  ensureUniqueWhatsappPhone(database, whatsappPhoneNumber, ctx.user.id);

  database
    .prepare(
      `
    UPDATE app_users
    SET display_name = ?, whatsapp_phone_number = ?, updated_at = ?
    WHERE id = ?
  `,
    )
    .run(
      displayName,
      whatsappPhoneNumber,
      new Date().toISOString(),
      ctx.user.id,
    );
  return database
    .prepare(
      "SELECT id, username, display_name, whatsapp_phone_number, role FROM app_users WHERE id = ?",
    )
    .get(ctx.user.id);
}

async function createAppSession(userId) {
  const database = await getDb();
  const sessionId = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  database
    .prepare(
      `
    INSERT INTO app_sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      sessionId,
      userId,
      csrfToken,
      now.toISOString(),
      expires.toISOString(),
      now.toISOString(),
    );
  return { id: sessionId, userId, csrfToken, expiresAt: expires.toISOString() };
}

function parseCookies(header) {
  const cookies = new Map();
  for (const item of String(header || "").split(";")) {
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    cookies.set(
      item.slice(0, eq).trim(),
      decodeURIComponent(item.slice(eq + 1).trim()),
    );
  }
  return cookies;
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) res.setHeader("Set-Cookie", cookie);
  else if (Array.isArray(current))
    res.setHeader("Set-Cookie", [...current, cookie]);
  else res.setHeader("Set-Cookie", [current, cookie]);
}

function setAppSessionCookie(res, session) {
  appendSetCookie(
    res,
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  );
}

function clearAppSessionCookie(res) {
  appendSetCookie(
    res,
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

async function optionalAppContext(req) {
  const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
  if (!sessionId) return null;
  const database = await getDb();
  const row = database
    .prepare(
      `
    SELECT s.id AS session_id, s.user_id, s.csrf_token, s.expires_at,
      u.id, u.username, u.display_name, u.whatsapp_phone_number, u.role
    FROM app_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.id = ?
  `,
    )
    .get(sessionId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    database.prepare("DELETE FROM app_sessions WHERE id = ?").run(sessionId);
    return null;
  }
  database
    .prepare("UPDATE app_sessions SET last_seen_at = ? WHERE id = ?")
    .run(new Date().toISOString(), sessionId);
  return {
    user: publicAppUser(row),
    session: {
      id: row.session_id,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    },
  };
}

async function requireAppContext(req) {
  const ctx = await optionalAppContext(req);
  if (!ctx) throw httpError(401, "Login aplikasi diperlukan.");
  return ctx;
}

function requireAppCsrf(req, ctx) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const token = req.headers["x-app-csrf-token"];
  if (!ctx?.session?.csrfToken || token !== ctx.session.csrfToken) {
    throw httpError(
      403,
      "Token aplikasi tidak valid. Refresh halaman lalu coba lagi.",
    );
  }
}

async function deleteAppSession(sessionId) {
  const database = await getDb();
  database.prepare("DELETE FROM app_sessions WHERE id = ?").run(sessionId);
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

async function listPhotos(ctx) {
  const database = await getDb();
  return database
    .prepare(
      `
    SELECT id, label, image_base64, created_at, used_at
    FROM saved_photos
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `,
    )
    .all(ctx.user.id, MAX_SAVED_PHOTOS)
    .map(photoSummary);
}

async function getPhoto(ctx, id) {
  const photoId = Number(id);
  if (!Number.isInteger(photoId) || photoId <= 0) return null;
  const database = await getDb();
  const row = database
    .prepare(
      `
    SELECT id, label, image_base64, created_at, used_at
    FROM saved_photos
    WHERE user_id = ? AND id = ?
  `,
    )
    .get(ctx.user.id, photoId);
  return row ? photoSummary(row) : null;
}

async function savePhoto(ctx, input) {
  const imageBase64 = String(input.imageBase64 || "");
  validatePhotoDataUrl(imageBase64);

  const label =
    String(input.label || "").trim() ||
    `Foto ${new Date().toLocaleString("id-ID")}`;
  const database = await getDb();
  const result = database
    .prepare(
      `
    INSERT INTO saved_photos (user_id, label, image_base64, created_at, used_at)
    VALUES (?, ?, ?, ?, NULL)
  `,
    )
    .run(
      ctx.user.id,
      label.slice(0, 120),
      imageBase64,
      new Date().toISOString(),
    );

  database
    .prepare(
      `
    DELETE FROM saved_photos
    WHERE user_id = ? AND id NOT IN (
      SELECT id FROM saved_photos
      WHERE user_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    )
  `,
    )
    .run(ctx.user.id, ctx.user.id, MAX_SAVED_PHOTOS);

  return getPhoto(ctx, result.lastInsertRowid);
}

async function deletePhoto(ctx, id) {
  const photoId = Number(id);
  if (!Number.isInteger(photoId) || photoId <= 0)
    throw new Error("Photo ID tidak valid");
  const database = await getDb();
  const result = database
    .prepare("DELETE FROM saved_photos WHERE user_id = ? AND id = ?")
    .run(ctx.user.id, photoId);
  return { deleted: result.changes > 0 };
}

async function markPhotoUsed(ctx, id) {
  const photoId = Number(id);
  if (!Number.isInteger(photoId) || photoId <= 0) return;
  const database = await getDb();
  database
    .prepare("UPDATE saved_photos SET used_at = ? WHERE user_id = ? AND id = ?")
    .run(new Date().toISOString(), ctx.user.id, photoId);
}

function estimateDataUrlBytes(value) {
  const base64 = String(value || "").split(",")[1] || "";
  return Math.ceil((base64.length * 3) / 4);
}

function validatePhotoDataUrl(imageBase64) {
  if (!imageBase64.startsWith("data:image/"))
    throw new Error("Foto wajib dalam format data:image/...;base64");
  if (estimateDataUrlBytes(imageBase64) > MAX_PHOTO_BYTES)
    throw new Error("Ukuran foto terlalu besar. Maksimal 4 MB per foto.");
}

function isLocalHostname(value) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    String(value || "").toLowerCase(),
  );
}

function hostnameFromHostHeader(value) {
  const host = String(value || "").toLowerCase();
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0];
}

function parseAllowedAppOrigins(value) {
  const origins = new Set();
  const hostnames = new Set();
  for (const item of String(value || "").split(/[\s,;]+/g)) {
    if (!item) continue;
    try {
      const url = new URL(item);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      origins.add(url.origin.toLowerCase());
      hostnames.add(url.hostname.toLowerCase());
    } catch {
      hostnames.add(item.toLowerCase());
    }
  }
  return { origins, hostnames };
}

const ALLOWED_APP = parseAllowedAppOrigins(process.env.APP_ALLOWED_ORIGINS);

function isAllowedAppHostname(value) {
  const hostname = String(value || "").toLowerCase();
  return isLocalHostname(hostname) || ALLOWED_APP.hostnames.has(hostname);
}

function isAllowedAppOrigin(value) {
  try {
    const origin = new URL(value).origin.toLowerCase();
    return (
      isLocalHostname(new URL(value).hostname) ||
      ALLOWED_APP.origins.has(origin)
    );
  } catch {
    return false;
  }
}

function isAllowedAppRequest(req) {
  if (!isAllowedAppHostname(hostnameFromHostHeader(req.headers.host)))
    return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  return isAllowedAppOrigin(origin);
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
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
  return (
    !response.ok || payload.status === "fail" || payload.status === "error"
  );
}

function getSetCookie(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;=]+=[^;]+)/g);
}

function getHrisSession(ctx) {
  const userId = ctx.user.id;
  if (!hrisSessions.has(userId)) {
    hrisSessions.set(userId, {
      userId,
      jar: new Map(),
      lastCsrfToken: "",
      loaded: false,
    });
  }
  return hrisSessions.get(userId);
}

async function saveSession(ctx) {
  const session = getHrisSession(ctx);
  const database = await getDb();
  database
    .prepare(
      `
    INSERT INTO hris_sessions (user_id, cookies_json, last_csrf_token, saved_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      cookies_json = excluded.cookies_json,
      last_csrf_token = excluded.last_csrf_token,
      saved_at = excluded.saved_at
  `,
    )
    .run(
      session.userId,
      JSON.stringify(Object.fromEntries(session.jar)),
      session.lastCsrfToken,
      new Date().toISOString(),
    );
}

async function loadSession(ctx) {
  const session = getHrisSession(ctx);
  if (session.loaded) return session;
  session.loaded = true;

  try {
    const database = await getDb();
    const row = database
      .prepare(
        "SELECT cookies_json, last_csrf_token FROM hris_sessions WHERE user_id = ?",
      )
      .get(session.userId);
    if (!row) return session;
    const cookies = JSON.parse(row.cookies_json || "{}");
    for (const [key, value] of Object.entries(cookies || {})) {
      if (key && value) session.jar.set(key, String(value));
    }
    session.lastCsrfToken = String(row.last_csrf_token || "");
  } catch {
    session.jar.clear();
    session.lastCsrfToken = "";
  }
  return session;
}

async function clearSession(ctx) {
  const session = getHrisSession(ctx);
  session.jar.clear();
  session.lastCsrfToken = "";
  await saveSession(ctx);
}

function storeCookies(session, headers) {
  let changed = false;
  for (const cookie of getSetCookie(headers)) {
    const first = cookie.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) {
      session.jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      changed = true;
    }
  }
  return changed;
}

function cookieHeader(session) {
  return [...session.jar.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function devAttendanceState(session) {
  if (!session.devAttendance) {
    session.devAttendance = {
      clockedIn: false,
      attendanceId: DEV_ATTENDANCE_ID,
      clockInAt: "",
    };
  }
  return session.devAttendance;
}

function mockHrisResponse(
  body,
  { status = 200, contentType = "text/html; charset=utf-8", headers = {} } = {},
) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      ...headers,
    },
  });
}

function mockHrisJson(payload, options = {}) {
  return mockHrisResponse(JSON.stringify(payload), {
    ...options,
    contentType: "application/json; charset=utf-8",
  });
}

function mockLoginHtml() {
  return `
    <!doctype html>
    <html><body>
      <form id="login-form" action="/login" method="post">
        <input type="hidden" name="_token" value="${DEV_CSRF_TOKEN}">
      </form>
    </body></html>
  `;
}

function mockDashboardHtml(session) {
  const attendance = devAttendanceState(session);
  const now = new Date();
  const dashboardClock = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dashboardDay = now.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const clockButton = attendance.clockedIn
    ? `<button id="clock-out">Clock Out</button>
       <script>
       function clockOut() {
         $.ajax({
           url: '/account/attendances/update-clock-in',
           data: { id: '${attendance.attendanceId}' },
           beforeSend: function () { var token = "${DEV_CSRF_TOKEN}"; },
           success: function () {}
         });
       }
       </script>`
    : '<button id="clock-in">Clock In</button>';

  return `
    <!doctype html>
    <html><body>
      <span id="dashboard-clock">${dashboardClock}</span><span>${dashboardDay}</span>
      ${clockButton}
    </body></html>
  `;
}

function mockClockInModalHtml() {
  return `
    <div id="clockInModal">
      <h4>Dev clock-in modal</h4>
      <input type="hidden" name="_token" value="${DEV_CSRF_TOKEN}">
      <select id="location" name="location">
        <option value="1" data-is-radius="1" selected>PT Minergo Visi Maxima</option>
      </select>
      <select name="work_from_type">
        <option value="office" selected>Office</option>
        <option value="home">Home</option>
        <option value="other">Other</option>
      </select>
      <input type="hidden" name="working_from" value="">
      <input type="hidden" name="currentLatitude" value="${DEFAULT_LATITUDE}">
      <input type="hidden" name="currentLongitude" value="${DEFAULT_LONGITUDE}">
      <input type="hidden" name="imageBase64" value="">
    </div>
  `;
}

function mockClockOutModalHtml(session) {
  const attendance = devAttendanceState(session);
  return `
    <div id="clockOutModal">
      <h5 id="modelHeading">Clock Out</h5>
      <h4>Date - ${new Date().toLocaleDateString("id-ID")}</h4>
      <p>Clock In</p><p class="res-activity-time">${attendance.clockInAt || "-"}</p>
      <p>Clock Out</p><p class="res-activity-time">-</p>
      <input type="hidden" name="_token" value="${DEV_CSRF_TOKEN}">
    </div>
  `;
}

async function mockHrisFetch(ctx, session, url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const pathname = String(url).split("?")[0];
  const attendance = devAttendanceState(session);
  session.jar.set("hris_dev_session", `user-${ctx.user.id}`);
  session.lastCsrfToken = DEV_CSRF_TOKEN;
  await saveSession(ctx);

  if (pathname === "/login" && method === "GET")
    return mockHrisResponse(mockLoginHtml());
  if (pathname === "/login" && method === "POST") {
    return mockHrisJson({
      status: "success",
      message: "Dev login dummy sukses",
      devMode: true,
    });
  }
  if (pathname === "/account/dashboard")
    return mockHrisResponse(mockDashboardHtml(session));
  if (pathname === "/account/attendances/clock-in-modal")
    return mockHrisResponse(mockClockInModalHtml());
  if (pathname === "/account/attendances/show_clocked_hours")
    return mockHrisResponse(mockClockOutModalHtml(session));
  if (pathname === "/account/attendances/store-clock-in" && method === "POST") {
    attendance.clockedIn = true;
    attendance.clockInAt = new Date().toLocaleString("id-ID");
    return mockHrisJson({
      status: "success",
      message: "Dev clock-in dummy sukses",
      attendanceId: attendance.attendanceId,
      devMode: true,
    });
  }
  if (pathname === "/account/attendances/update-clock-in") {
    attendance.clockedIn = false;
    return mockHrisJson({
      status: "success",
      message: "Dev clock-out dummy sukses",
      attendanceId: attendance.attendanceId,
      devMode: true,
    });
  }

  return mockHrisJson(
    {
      status: "error",
      message: `Mock HRIS endpoint belum tersedia: ${method} ${pathname}`,
      devMode: true,
    },
    { status: 404 },
  );
}

function isLoginRedirect(response) {
  const location = response.headers.get("location") || "";
  return (
    response.status >= 300 &&
    response.status < 400 &&
    /\/login(?:$|[?#])/i.test(location)
  );
}

function isLoginPageHtml(html) {
  return (
    /id=["']login-form["']/i.test(html) ||
    /<form\b[^>]*action=["'][^"']*\/login[^"']*["'][^>]*>/i.test(html)
  );
}

async function hrisFetch(ctx, url, options = {}) {
  const session = await loadSession(ctx);
  if (HRIS_DEV_MODE) return mockHrisFetch(ctx, session, url, options);

  const headers = new Headers(options.headers || {});
  const cookies = cookieHeader(session);
  if (cookies) headers.set("Cookie", cookies);
  headers.set("User-Agent", headers.get("User-Agent") || "Mozilla/5.0");

  const response = await fetch(`${BASE_URL}${url}`, {
    redirect: options.redirect || "manual",
    ...options,
    headers,
  });
  if (storeCookies(session, response.headers)) await saveSession(ctx);
  return response;
}

function extractCsrfLoose(ctx, html) {
  const session = getHrisSession(ctx);
  const token =
    html.match(/name="_token"\s+value="([^"]+)"/)?.[1] ||
    html.match(/"csrfToken"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i)?.[1] ||
    "";

  if (token) {
    session.lastCsrfToken = decodeHtml(token);
    saveSession(ctx).catch(() => {});
  }
  return session.lastCsrfToken;
}

function extractCsrf(ctx, html) {
  const token = extractCsrfLoose(ctx, html);
  if (!token) throw new Error("CSRF token tidak ditemukan");
  return token;
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripTags(value) {
  return decodeHtml(
    value
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function readHtmlAttr(attrs, name) {
  const match = String(attrs || "").match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function parseFormFields(html) {
  const fields = {};
  const shouldSkip = (name) => !name || name.startsWith("f_");

  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let match;
  while ((match = selectRegex.exec(html))) {
    const name = readHtmlAttr(match[1], "name");
    if (shouldSkip(name)) continue;

    const options = [
      ...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi),
    ];
    const selected = options.find((option) => /\bselected\b/i.test(option[1]));
    const option = selected || options[0];
    fields[name] = option
      ? readHtmlAttr(option[1], "value") || stripTags(option[2] || "")
      : "";
  }

  const textareaRegex = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((match = textareaRegex.exec(html))) {
    const name = readHtmlAttr(match[1], "name");
    if (!shouldSkip(name)) fields[name] = stripTags(match[2] || "");
  }

  const inputRegex = /<input\b([^>]*)>/gi;
  while ((match = inputRegex.exec(html))) {
    const attrs = match[1];
    const name = readHtmlAttr(attrs, "name");
    if (shouldSkip(name)) continue;

    const type = readHtmlAttr(attrs, "type").toLowerCase() || "text";
    if (
      (type === "checkbox" || type === "radio") &&
      !/\bchecked\b/i.test(attrs)
    )
      continue;
    fields[name] = readHtmlAttr(attrs, "value");
  }

  return fields;
}

function parseModal(ctx, html) {
  const csrfToken = extractCsrf(ctx, html);
  const locations = [];
  const selectMatch = html.match(
    /<select[^>]+id="location"[\s\S]*?<\/select>/i,
  );

  if (selectMatch) {
    const optionRegex = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
    let match;
    while ((match = optionRegex.exec(selectMatch[0]))) {
      const attrs = match[1];
      const value = attrs.match(/value="([^"]*)"/)?.[1] || "";
      if (!value) continue;
      locations.push({
        id: value,
        name: stripTags(match[2]),
        isRadius: attrs.match(/data-is-radius="([^"]*)"/)?.[1] ?? "",
        selected: /selected/i.test(attrs),
      });
    }
  }

  return {
    csrfToken,
    fields: parseFormFields(html),
    locations,
    workFromTypes: [
      ...html.matchAll(/<option\s+value="([^"]+)">([\s\S]*?)<\/option>/gi),
    ]
      .map((match) => ({ value: match[1], label: stripTags(match[2]) }))
      .filter((item) => ["office", "home", "other"].includes(item.value)),
    lastAttendanceId:
      html.match(/id="last_attendance_id"[^>]+value="([^"]*)"/)?.[1] || "",
    lastAttendanceDate:
      html.match(/id="last_attendance_date"[^>]+value="([^"]*)"/)?.[1] || "",
    requiresFixClockOut: html.includes('id="last_attendance_id"'),
    rawTimeLabel: stripTags(
      html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || "",
    ),
  };
}

function extractActivityTime(html, label) {
  const regex = new RegExp(
    `<p[^>]*>\\s*${label}[\\s\\S]*?<\\/p>\\s*<p[^>]*class="res-activity-time"[^>]*>([\\s\\S]*?)<\\/p>`,
    "i",
  );
  const value = stripTags(html.match(regex)?.[1] || "")
    .replace(/^\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return value.match(/\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}/)?.[0] || value;
}

function parseClockOutModal(html) {
  return {
    fields: parseFormFields(html),
    requiresPhoto:
      html.includes('id="imageBase64"') || html.includes('name="imageBase64"'),
    rawTitle: stripTags(
      html.match(/<h5[^>]*id="modelHeading"[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ||
        "Clock Out",
    ),
    attendanceDate: stripTags(
      html.match(/Date\s*-\s*([\s\S]*?)<\/h4>/i)?.[1] || "",
    ),
    clockInAt: extractActivityTime(html, "Clock In"),
    clockOutAt: extractActivityTime(html, "Clock Out"),
  };
}

function parseDashboardStatus(ctx, html) {
  const clockBlock = html.match(
    /<span[^>]+id="dashboard-clock"[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
  );
  const clock = stripTags(clockBlock?.[1] || "");
  const day = stripTags(clockBlock?.[2] || "");
  const hasClockOut = html.includes('id="clock-out"');
  const hasClockIn = html.includes('id="clock-in"');
  const clockOutOptions = parseClockOutOptionsFromDashboard(ctx, html);

  return {
    dashboardClock: clock,
    dashboardDay: day,
    attendanceStatus: hasClockOut
      ? "clocked_in"
      : hasClockIn
        ? "not_clocked_in"
        : "unknown",
    attendanceStatusLabel: hasClockOut
      ? "Clocked In"
      : hasClockIn
        ? "Not Clocked In"
        : "Unknown",
    canClockIn: hasClockIn,
    canClockOut: hasClockOut,
    attendanceId: clockOutOptions.attendanceId,
  };
}

async function readJson(req) {
  if (
    req.method !== "GET" &&
    !String(req.headers["content-type"] || "").includes("application/json")
  ) {
    throw new Error("Content-Type wajib application/json");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES)
      throw new Error("Request terlalu besar. Maksimal 6 MB.");
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Body JSON tidak valid");
  }
}

function normalizeTimeSetting(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeReminderLeadMinutes(value, fallback) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return fallback;
  return Math.max(1, Math.min(60, Math.round(minutes)));
}

function normalizeSenderInput(value) {
  return normalizeAuthorizedSenders(
    Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/g),
  ).slice(0, 10);
}

const DEFAULT_SETTINGS = {
  defaultLocationId: "1",
  workingFrom: "",
  officeLatitude: DEFAULT_LATITUDE,
  officeLongitude: DEFAULT_LONGITUDE,
  officeName: "PT Minergo Visi Maxima",
  scheduleEnabled: false,
  checkInTime: "09:00",
  checkOutTime: "18:00",
  randomCheckInEnabled: false,
  randomCheckOutEnabled: false,
  randomPhotoEnabled: false,
  selectedPhotoId: "",
  checkInStartTime: "08:45",
  checkInEndTime: "09:00",
  checkOutStartTime: "17:45",
  checkOutEndTime: "18:15",
  ...DEFAULT_WHATSAPP_SETTINGS,
};

async function readSettingsForUserId(userId) {
  const database = await getDb();
  const row = database
    .prepare("SELECT value FROM user_settings WHERE user_id = ?")
    .get(userId);
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function readSettings(ctx) {
  return readSettingsForUserId(ctx.user.id);
}

function sanitizeSettingsPatch(current, settings) {
  return {
    ...current,
    defaultLocationId: Object.hasOwn(settings, "defaultLocationId")
      ? String(settings.defaultLocationId || "")
      : current.defaultLocationId,
    workingFrom: Object.hasOwn(settings, "workingFrom")
      ? String(settings.workingFrom || "")
      : current.workingFrom,
    officeLatitude: Object.hasOwn(settings, "officeLatitude")
      ? String(settings.officeLatitude || current.officeLatitude || "")
      : current.officeLatitude,
    officeLongitude: Object.hasOwn(settings, "officeLongitude")
      ? String(settings.officeLongitude || current.officeLongitude || "")
      : current.officeLongitude,
    officeName: Object.hasOwn(settings, "officeName")
      ? String(settings.officeName || current.officeName || "")
      : current.officeName,
    scheduleEnabled: Object.hasOwn(settings, "scheduleEnabled")
      ? Boolean(settings.scheduleEnabled)
      : Boolean(current.scheduleEnabled),
    checkInTime: Object.hasOwn(settings, "checkInTime")
      ? normalizeTimeSetting(settings.checkInTime, "09:00")
      : current.checkInTime,
    checkOutTime: Object.hasOwn(settings, "checkOutTime")
      ? normalizeTimeSetting(settings.checkOutTime, "18:00")
      : current.checkOutTime,
    randomCheckInEnabled: Object.hasOwn(settings, "randomCheckInEnabled")
      ? Boolean(settings.randomCheckInEnabled)
      : Boolean(current.randomCheckInEnabled),
    randomCheckOutEnabled: Object.hasOwn(settings, "randomCheckOutEnabled")
      ? Boolean(settings.randomCheckOutEnabled)
      : Boolean(current.randomCheckOutEnabled),
    randomPhotoEnabled: Object.hasOwn(settings, "randomPhotoEnabled")
      ? Boolean(settings.randomPhotoEnabled)
      : Boolean(current.randomPhotoEnabled),
    selectedPhotoId: Object.hasOwn(settings, "selectedPhotoId")
      ? String(settings.selectedPhotoId || "")
      : current.selectedPhotoId,
    checkInStartTime: Object.hasOwn(settings, "checkInStartTime")
      ? normalizeTimeSetting(settings.checkInStartTime, "08:45")
      : current.checkInStartTime,
    checkInEndTime: Object.hasOwn(settings, "checkInEndTime")
      ? normalizeTimeSetting(settings.checkInEndTime, "09:00")
      : current.checkInEndTime,
    checkOutStartTime: Object.hasOwn(settings, "checkOutStartTime")
      ? normalizeTimeSetting(settings.checkOutStartTime, "17:45")
      : current.checkOutStartTime,
    checkOutEndTime: Object.hasOwn(settings, "checkOutEndTime")
      ? normalizeTimeSetting(settings.checkOutEndTime, "18:15")
      : current.checkOutEndTime,
    whatsappBotEnabled: Object.hasOwn(settings, "whatsappBotEnabled")
      ? Boolean(settings.whatsappBotEnabled)
      : Boolean(current.whatsappBotEnabled),
    whatsappReminderEnabled: Object.hasOwn(settings, "whatsappReminderEnabled")
      ? Boolean(settings.whatsappReminderEnabled)
      : Boolean(current.whatsappReminderEnabled),
    whatsappGroupJid: Object.hasOwn(settings, "whatsappGroupJid")
      ? normalizeGroupJid(settings.whatsappGroupJid)
      : normalizeGroupJid(current.whatsappGroupJid),
    whatsappAuthorizedSenders: Object.hasOwn(
      settings,
      "whatsappAuthorizedSenders",
    )
      ? normalizeSenderInput(settings.whatsappAuthorizedSenders)
      : normalizeSenderInput(current.whatsappAuthorizedSenders),
    whatsappReminderLeadMinutes: Object.hasOwn(
      settings,
      "whatsappReminderLeadMinutes",
    )
      ? normalizeReminderLeadMinutes(settings.whatsappReminderLeadMinutes, 5)
      : normalizeReminderLeadMinutes(current.whatsappReminderLeadMinutes, 5),
    whatsappClockInTargetStartTime: Object.hasOwn(
      settings,
      "whatsappClockInTargetStartTime",
    )
      ? normalizeTimeSetting(settings.whatsappClockInTargetStartTime, "08:55")
      : current.whatsappClockInTargetStartTime,
    whatsappClockInTargetEndTime: Object.hasOwn(
      settings,
      "whatsappClockInTargetEndTime",
    )
      ? normalizeTimeSetting(settings.whatsappClockInTargetEndTime, "09:10")
      : current.whatsappClockInTargetEndTime,
    whatsappClockOutTargetStartTime: Object.hasOwn(
      settings,
      "whatsappClockOutTargetStartTime",
    )
      ? normalizeTimeSetting(settings.whatsappClockOutTargetStartTime, "17:55")
      : current.whatsappClockOutTargetStartTime,
    whatsappClockOutTargetEndTime: Object.hasOwn(
      settings,
      "whatsappClockOutTargetEndTime",
    )
      ? normalizeTimeSetting(settings.whatsappClockOutTargetEndTime, "18:10")
      : current.whatsappClockOutTargetEndTime,
  };
}

async function saveSettingsForUserId(userId, settings) {
  const current = await readSettingsForUserId(userId);
  const safe = sanitizeSettingsPatch(current, settings);
  const database = await getDb();
  database
    .prepare(
      `
    INSERT INTO user_settings (user_id, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `,
    )
    .run(userId, JSON.stringify(safe), new Date().toISOString());
  return safe;
}

async function saveSettings(ctx, settings) {
  return saveSettingsForUserId(ctx.user.id, settings);
}

async function readUserState(userId, key) {
  const database = await getDb();
  const row = database
    .prepare("SELECT value FROM user_app_state WHERE user_id = ? AND key = ?")
    .get(userId, key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function writeUserState(userId, key, value) {
  const database = await getDb();
  database
    .prepare(
      `
    INSERT INTO user_app_state (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `,
    )
    .run(userId, key, JSON.stringify(value), new Date().toISOString());
}

async function listAppUsers() {
  const database = await getDb();
  return database
    .prepare(
      "SELECT id, username, display_name, whatsapp_phone_number, role FROM app_users ORDER BY id",
    )
    .all()
    .map(publicAppUser);
}

async function stopWhatsappBot() {
  if (!whatsappBot) return;
  const bot = whatsappBot;
  whatsappBot = null;
  await bot
    .stop()
    .catch((error) =>
      console.error(`WhatsApp bot stop failed: ${error.message}`),
    );
}

function botContextForUser(user) {
  const ctx = { user };
  return {
    readState: (key) => readUserState(user.id, key),
    writeState: (key, value) => writeUserState(user.id, key, value),
    getSessionStatus: () => getSessionStatus(ctx),
    getDashboardStatus: () => getDashboardStatus(ctx),
    storeClockIn: (input) => storeClockIn(ctx, input),
    storeClockOut: (input) => storeClockOut(ctx, input),
    listPhotos: () => listPhotos(ctx),
    getPhoto: (id) => getPhoto(ctx, id),
  };
}

async function listWhatsappUsers() {
  const users = await listAppUsers();
  const entries = [];
  for (const user of users) {
    entries.push({ user, settings: await readSettingsForUserId(user.id) });
  }
  return entries;
}

async function syncWhatsappBot() {
  const users = await listWhatsappUsers();
  if (!users.some((entry) => entry.settings.whatsappBotEnabled)) {
    await stopWhatsappBot();
    return;
  }
  if (whatsappBot || whatsappBotStarting) return;

  whatsappBotStarting = startWhatsappBot({
    dataDir: DATA_DIR,
    resolveSender: async (senderJid, groupJid) => {
      const entries = await listWhatsappUsers();
      const normalizedGroupJid = normalizeGroupJid(groupJid);
      const enabledGroups = new Set(
        entries
          .filter((entry) => entry.settings.whatsappBotEnabled)
          .map((entry) => normalizeGroupJid(entry.settings.whatsappGroupJid))
          .filter(Boolean),
      );

      if (!normalizedGroupJid || !enabledGroups.has(normalizedGroupJid))
        return { type: "ignored", groupJid: normalizedGroupJid };

      const resolved = resolveWhatsappPhoneUser(senderJid, entries);
      if (resolved.type !== "matched") return resolved;
      return { ...resolved, deps: botContextForUser(resolved.user) };
    },
    listReminderTargets: async () => {
      const seenGroups = new Set();
      const targets = [];
      for (const entry of await listWhatsappUsers()) {
        const groupJid = normalizeGroupJid(entry.settings.whatsappGroupJid);
        if (
          !entry.settings.whatsappBotEnabled ||
          !groupJid ||
          seenGroups.has(groupJid)
        )
          continue;
        seenGroups.add(groupJid);
        targets.push({
          settings: entry.settings,
          deps: botContextForUser(entry.user),
        });
      }
      return targets;
    },
  })
    .then((bot) => {
      whatsappBot = bot;
      console.log("WhatsApp bot started.");
    })
    .catch((error) =>
      console.error(`WhatsApp bot start failed: ${error.message}`),
    )
    .finally(() => {
      whatsappBotStarting = null;
    });

  await whatsappBotStarting;
}

async function login(ctx, { email, password }) {
  const session = await loadSession(ctx);
  session.jar.clear();
  session.lastCsrfToken = "";
  const page = await hrisFetch(ctx, "/login", {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
      "X-Forwarded-For": randomIP(),
    },
  });
  const html = await page.text();
  const token = extractCsrf(ctx, html);

  const body = new URLSearchParams({
    _token: token,
    email,
    password,
    locale: "en",
    current_latitude: "",
    current_longitude: "",
    g_recaptcha: "",
  });

  const response = await hrisFetch(ctx, "/login", {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/login`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Forwarded-For": randomIP(),
    },
    body,
  });

  const payload = await readResponsePayload(response, 500);

  if (isFailedPayload(response, payload)) {
    await clearSession(ctx);
    throw new Error(payload.message || payload.error || "Login gagal");
  }
  await saveSession(ctx);
  await getDashboardHtml(ctx);
  return payload;
}

async function getDashboardHtml(ctx) {
  const response = await hrisFetch(ctx, "/account/dashboard", {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
      "X-Forwarded-For": randomIP(),
    },
  });
  const html = await response.text();
  if (isLoginRedirect(response) || isLoginPageHtml(html)) {
    await clearSession(ctx);
    throw new Error("Session HRIS habis, silakan login ulang");
  }
  if (!response.ok)
    throw new Error(`Dashboard HRIS gagal dimuat (${response.status})`);
  extractCsrfLoose(ctx, html);
  return html;
}

function parseClockOutOptionsFromDashboard(ctx, html) {
  const session = getHrisSession(ctx);
  const hasClockOut = html.includes('id="clock-out"');
  const updateBlock =
    html.match(
      /function\s+clockOut\s*\(\)\s*{[\s\S]*?update-clock-in[\s\S]*?success\s*:/i,
    )?.[0] || "";
  const csrfToken =
    updateBlock.match(/var\s+token\s*=\s*"([^"]+)"/)?.[1] ||
    html.match(/"csrfToken":"([^"]+)"/)?.[1] ||
    session.lastCsrfToken;
  const attendanceId =
    updateBlock.match(/id:\s*'([^']+)'/)?.[1] ||
    updateBlock.match(/id:\s*"([^"]+)"/)?.[1] ||
    "";

  return {
    canClockOut: hasClockOut && Boolean(attendanceId),
    attendanceId,
    csrfToken,
  };
}

async function getClockInModal(ctx) {
  const response = await hrisFetch(ctx, "/account/attendances/clock-in-modal", {
    headers: {
      Accept: "text/html, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
      Referer: `${BASE_URL}/account/dashboard`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Forwarded-For": randomIP(),
    },
  });
  const html = await response.text();
  if (isLoginRedirect(response) || isLoginPageHtml(html)) {
    await clearSession(ctx);
    throw new Error("Session HRIS habis, silakan login ulang");
  }
  if (!response.ok)
    throw new Error(`Modal clock-in HRIS gagal dimuat (${response.status})`);
  return parseModal(ctx, html);
}

async function getSessionStatus(ctx) {
  const session = await loadSession(ctx);
  if (session.jar.size === 0) return { loggedIn: false };

  try {
    await getDashboardHtml(ctx);
    return { loggedIn: true };
  } catch (error) {
    if (error.message.includes("Session HRIS habis"))
      return { loggedIn: false };
    throw error;
  }
}

async function getClockOutOptions(ctx) {
  const html = await getDashboardHtml(ctx);
  const options = parseClockOutOptionsFromDashboard(ctx, html);

  if (options.canClockOut) {
    const modalResponse = await hrisFetch(
      ctx,
      `/account/attendances/show_clocked_hours?aid=${encodeURIComponent(options.attendanceId)}`,
      {
        headers: {
          Accept: "text/html, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
          Referer: `${BASE_URL}/account/dashboard`,
          "X-Requested-With": "XMLHttpRequest",
          "X-Forwarded-For": randomIP(),
        },
      },
    );
    const modalHtml = await modalResponse.text();
    return { ...options, ...parseClockOutModal(modalHtml) };
  }

  return options;
}

async function getDashboardStatus(ctx) {
  const html = await getDashboardHtml(ctx);
  const status = parseDashboardStatus(ctx, html);

  if (status.canClockOut && status.attendanceId) {
    const details = await getClockOutOptions(ctx);
    return {
      ...status,
      attendanceDate: details.attendanceDate || "",
      clockInAt: details.clockInAt || "",
      clockOutAt: details.clockOutAt || "",
    };
  }

  return {
    ...status,
    attendanceDate: "",
    clockInAt: "",
    clockOutAt: "",
  };
}

async function storeClockIn(ctx, input) {
  const settings = await readSettings(ctx);
  const session = getHrisSession(ctx);
  const modal = input.csrfToken ? null : await getClockInModal(ctx);
  const token = String(
    input.csrfToken || modal?.csrfToken || session.lastCsrfToken || "",
  );
  const location = String(
    input.location ||
      settings.defaultLocationId ||
      modal?.locations?.find((item) => item.selected)?.id ||
      "",
  );
  const fallbackCoords = randomCoordinateInRange(
    settings.officeLatitude || DEFAULT_LATITUDE,
    settings.officeLongitude || DEFAULT_LONGITUDE,
  );
  const currentLatitude = String(
    input.currentLatitude || fallbackCoords.latitude,
  );
  const currentLongitude = String(
    input.currentLongitude || fallbackCoords.longitude,
  );
  const selectedPhoto = input.photoId
    ? await getPhoto(ctx, input.photoId)
    : null;
  const imageBase64 = String(
    input.imageBase64 || selectedPhoto?.imageBase64 || "",
  );

  if (!token)
    throw new Error(
      "CSRF token clock-in tidak ditemukan. Refresh data lalu coba lagi.",
    );
  if (input.photoId && !selectedPhoto)
    throw new Error("Foto tersimpan tidak ditemukan");
  if (!location) throw new Error("Location belum dipilih");
  if (!currentLatitude || !currentLongitude)
    throw new Error("Latitude/longitude belum tersedia");
  validatePhotoDataUrl(imageBase64);

  const body = new URLSearchParams(modal?.fields || {});
  body.set(
    "working_from",
    String(input.working_from || settings.workingFrom || ""),
  );
  body.set("location", location);
  body.set("work_from_type", String(input.work_from_type || "office"));
  body.set("currentLatitude", currentLatitude);
  body.set("currentLongitude", currentLongitude);
  body.set("imageBase64", imageBase64);
  body.set("fix_clock_out_time", String(input.fix_clock_out_time || ""));
  body.set("fix_clock_out_note", String(input.fix_clock_out_note || ""));
  body.set(
    "last_attendance_id",
    String(input.last_attendance_id || modal?.lastAttendanceId || ""),
  );
  body.set(
    "last_attendance_date",
    String(input.last_attendance_date || modal?.lastAttendanceDate || ""),
  );
  body.set("_token", token);

  const response = await hrisFetch(ctx, "/account/attendances/store-clock-in", {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/account/dashboard`,
      "X-Requested-With": "XMLHttpRequest",
      "X-Forwarded-For": randomIP(),
    },
    body,
  });

  const payload = await readResponsePayload(response);

  if (isFailedPayload(response, payload)) {
    throw new Error(payload.message || payload.error || "Clock-in gagal");
  }
  if (selectedPhoto) await markPhotoUsed(ctx, selectedPhoto.id);
  return payload;
}

async function storeClockOut(ctx, input) {
  const session = getHrisSession(ctx);
  const options =
    input.attendanceId && input.csrfToken
      ? null
      : await getClockOutOptions(ctx);
  const attendanceId = String(
    input.attendanceId || options?.attendanceId || "",
  );
  const token = String(
    input.csrfToken || options?.csrfToken || session.lastCsrfToken || "",
  );
  const fallbackCoords = randomCoordinateInRange(
    DEFAULT_LATITUDE,
    DEFAULT_LONGITUDE,
  );
  const currentLatitude = String(
    input.currentLatitude || fallbackCoords.latitude,
  );
  const currentLongitude = String(
    input.currentLongitude || fallbackCoords.longitude,
  );

  if (!attendanceId)
    throw new Error(
      "Attendance ID clock-out tidak ditemukan. Pastikan akun sedang clock-in.",
    );
  if (!token) throw new Error("CSRF token clock-out tidak ditemukan.");
  if (!currentLatitude || !currentLongitude)
    throw new Error("Latitude/longitude belum tersedia");

  const qs = new URLSearchParams({
    currentLatitude,
    currentLongitude,
    _token: token,
    id: attendanceId,
  });

  const response = await hrisFetch(
    ctx,
    `/account/attendances/update-clock-in?${qs.toString()}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
        Referer: `${BASE_URL}/account/dashboard`,
        "X-Requested-With": "XMLHttpRequest",
      },
    },
  );

  const payload = await readResponsePayload(response);

  if (isFailedPayload(response, payload)) {
    throw new Error(payload.message || payload.error || "Clock-out gagal");
  }
  return payload;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath))
    return text(res, 403, "Forbidden");

  try {
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    text(res, 200, buffer, types[ext] || "application/octet-stream");
  } catch {
    text(res, 404, "Not found");
  }
}

async function route(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const isApi = url.pathname.startsWith("/api/");

    if (isApi && !isAllowedAppRequest(req)) {
      return json(res, 403, {
        status: "error",
        message:
          "API hanya menerima request dari localhost atau APP_ALLOWED_ORIGINS.",
      });
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const ctx = await optionalAppContext(req);
      return json(res, 200, {
        setupRequired: (await appUserCount()) === 0,
        authenticated: Boolean(ctx),
        appUser: ctx?.user || null,
        appCsrfToken: ctx?.session?.csrfToken || "",
      });
    }

    if (req.method === "POST" && url.pathname === "/api/app/setup") {
      const user = await createFirstAdmin(await readJson(req));
      const session = await createAppSession(user.id);
      setAppSessionCookie(res, session);
      return json(res, 200, {
        setupRequired: false,
        authenticated: true,
        appUser: publicAppUser(user),
        appCsrfToken: session.csrfToken,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/app/login") {
      const payload = await readJson(req);
      const user = await findAppUserByUsername(payload.username);
      if (!user || !verifyPassword(payload.password, user.password_hash)) {
        throw httpError(401, "Username atau password aplikasi salah.");
      }
      const session = await createAppSession(user.id);
      setAppSessionCookie(res, session);
      return json(res, 200, {
        setupRequired: false,
        authenticated: true,
        appUser: publicAppUser(user),
        appCsrfToken: session.csrfToken,
      });
    }

    if (isApi) {
      const ctx = await requireAppContext(req);
      requireAppCsrf(req, ctx);

      if (req.method === "POST" && url.pathname === "/api/app/logout") {
        await deleteAppSession(ctx.session.id);
        clearAppSessionCookie(res);
        return json(res, 200, {
          authenticated: false,
          message: "Logout aplikasi sukses",
        });
      }

      if (req.method === "GET" && url.pathname === "/api/app/users") {
        return json(res, 200, { users: await listManagedAppUsers(ctx) });
      }

      if (req.method === "POST" && url.pathname === "/api/app/users") {
        const appUser = await createManagedAppUser(ctx, await readJson(req));
        return json(res, 200, { appUser, users: await listManagedAppUsers(ctx) });
      }

      if (req.method === "GET" && url.pathname === "/api/app/profile") {
        return json(res, 200, { appUser: ctx.user });
      }

      if (req.method === "POST" && url.pathname === "/api/app/profile") {
        const appUser = publicAppUser(
          await updateAppProfile(ctx, await readJson(req)),
        );
        return json(res, 200, { appUser });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const payload = await readJson(req);
        return json(res, 200, await login(ctx, payload));
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        return json(res, 200, await getSessionStatus(ctx));
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        await clearSession(ctx);
        return json(res, 200, { loggedIn: false, message: "Logout sukses" });
      }

      if (req.method === "GET" && url.pathname === "/api/clock-in-options") {
        const [settings, options] = await Promise.all([
          readSettings(ctx),
          getClockInModal(ctx),
        ]);
        return json(res, 200, { ...options, settings });
      }

      if (req.method === "GET" && url.pathname === "/api/clock-out-options") {
        return json(res, 200, await getClockOutOptions(ctx));
      }

      if (req.method === "GET" && url.pathname === "/api/dashboard-status") {
        return json(res, 200, await getDashboardStatus(ctx));
      }

      if (req.method === "GET" && url.pathname === "/api/settings") {
        return json(res, 200, await readSettings(ctx));
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const settings = await saveSettings(ctx, await readJson(req));
        syncWhatsappBot().catch((error) =>
          console.error(`WhatsApp bot sync failed: ${error.message}`),
        );
        return json(res, 200, settings);
      }

      if (req.method === "GET" && url.pathname === "/api/photos") {
        return json(res, 200, { photos: await listPhotos(ctx) });
      }

      if (req.method === "POST" && url.pathname === "/api/photos") {
        return json(res, 200, await savePhoto(ctx, await readJson(req)));
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/api/photos/")) {
        return json(
          res,
          200,
          await deletePhoto(ctx, url.pathname.split("/").pop()),
        );
      }

      if (req.method === "POST" && url.pathname === "/api/clock-in") {
        return json(res, 200, await storeClockIn(ctx, await readJson(req)));
      }

      if (req.method === "POST" && url.pathname === "/api/clock-out") {
        return json(res, 200, await storeClockOut(ctx, await readJson(req)));
      }

      throw httpError(404, "Endpoint API tidak ditemukan.");
    }

    return serveStatic(req, res);
  } catch (error) {
    return json(res, error.statusCode || 400, {
      status: "error",
      message: error.message,
    });
  }
}

const randomIP = () =>
  [...Array(4)].map(() => Math.floor(Math.random() * 256)).join(".");

const port = Number(process.env.PORT || 3000);
const server = createServer(route);
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${port} sudah dipakai. Jalankan dengan PORT lain, contoh: PORT=3100 npm start`,
    );
    process.exit(1);
  }
  throw error;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`HRIS Clock-In Helper running at http://127.0.0.1:${port}`);
  syncWhatsappBot().catch((error) =>
    console.error(`WhatsApp bot sync failed: ${error.message}`),
  );
});

process.on("SIGINT", async () => {
  await stopWhatsappBot();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await stopWhatsappBot();
  process.exit(0);
});

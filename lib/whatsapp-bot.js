import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import path from "node:path";
import pino from "pino";
import qrcode from "qrcode-terminal";

export const WHATSAPP_BOT_STATE_KEY = "whatsapp_bot_state";
export const DEFAULT_WHATSAPP_SETTINGS = {
  whatsappBotEnabled: false,
  whatsappReminderEnabled: true,
  whatsappGroupJid: "",
  whatsappAuthorizedSenders: [],
  whatsappReminderLeadMinutes: 5,
  whatsappClockInTargetStartTime: "08:55",
  whatsappClockInTargetEndTime: "09:10",
  whatsappClockOutTargetStartTime: "17:55",
  whatsappClockOutTargetEndTime: "18:10",
};

const ACTIONS = ["clock-in", "clock-out"];
const ACTION_LABELS = {
  "clock-in": "clock-in",
  "clock-out": "clock-out",
};

function enabledEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function shouldLogGroupMessages() {
  return enabledEnv(process.env.WHATSAPP_LOG_GROUP_MESSAGES);
}

function logGroupMessageDebug(details) {
  if (!shouldLogGroupMessages()) return;
  console.log(`WhatsApp group message debug: ${JSON.stringify(details)}`);
}

export function normalizeWhatsappPhone(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const withoutDomain = raw.replace(/@.*$/, "");
  const withoutDevice = withoutDomain.split(":")[0];
  return withoutDevice.replace(/[^0-9]/g, "");
}

export function normalizeSenderJid(value) {
  const digits = normalizeWhatsappPhone(value);
  return digits ? `${digits}@s.whatsapp.net` : "";
}

export function normalizeGroupJid(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!raw) return "";
  const groupId = raw
    .replace(/@g\.us$/, "")
    .replace(/@.*$/, "")
    .replace(/[^0-9-]/g, "");
  return groupId ? `${groupId}@g.us` : "";
}

export function isWhatsappLidJid(value) {
  return /@(?:hosted\.)?lid$/i.test(String(value || "").trim());
}

export async function resolveParticipantSenderJid(socket, participantJid) {
  const senderJid = String(participantJid || "").trim();
  if (!isWhatsappLidJid(senderJid)) return senderJid;

  try {
    return (
      (await socket?.signalRepository?.lidMapping?.getPNForLID(senderJid)) ||
      senderJid
    );
  } catch (error) {
    console.error(`WhatsApp LID lookup failed: ${error.message}`);
    return senderJid;
  }
}

export function normalizeAuthorizedSenders(values) {
  const list = Array.isArray(values)
    ? values
    : String(values || "").split(/[\s,;]+/g);
  return [...new Set(list.map(normalizeSenderJid).filter(Boolean))];
}

export function isAuthorizedSender(senderJid, authorizedSenders) {
  const normalized = normalizeSenderJid(senderJid);
  return (
    normalized &&
    normalizeAuthorizedSenders(authorizedSenders).includes(normalized)
  );
}

export function resolveWhatsappSenderUser(senderJid, users = []) {
  const normalized = normalizeSenderJid(senderJid);
  const matches = users.filter((item) =>
    isAuthorizedSender(normalized, item.settings?.whatsappAuthorizedSenders),
  );
  if (!matches.length) return { type: "none", senderJid: normalized };
  if (matches.length > 1)
    return { type: "conflict", senderJid: normalized, matches };
  return { type: "matched", senderJid: normalized, ...matches[0] };
}

export function resolveWhatsappPhoneUser(senderJid, users = []) {
  const phoneNumber = isWhatsappLidJid(senderJid)
    ? ""
    : normalizeWhatsappPhone(senderJid);
  const matches = phoneNumber
    ? users.filter(
        (item) =>
          normalizeWhatsappPhone(item.user?.whatsappPhoneNumber) ===
          phoneNumber,
      )
    : [];
  const sender = isWhatsappLidJid(senderJid)
    ? String(senderJid || "").trim()
    : normalizeSenderJid(senderJid);
  if (!matches.length) return { type: "none", senderJid: sender, phoneNumber };
  if (matches.length > 1)
    return { type: "conflict", senderJid: sender, phoneNumber, matches };
  return { type: "matched", senderJid: sender, phoneNumber, ...matches[0] };
}

export function normalizeTime(value, fallback) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function minutesFromTime(value, fallback = "00:00") {
  const normalized = normalizeTime(value, fallback);
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

export function timeFromMinutes(minutes) {
  const normalized = Math.max(0, Math.min(1439, Math.round(minutes)));
  const hour = String(Math.floor(normalized / 60)).padStart(2, "0");
  const minute = String(normalized % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

export function localDateKey(now = new Date()) {
  return now.toLocaleDateString("en-CA");
}

export function currentLocalTime(now = new Date()) {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function randomTargetInWindow(startTime, endTime, random = Math.random) {
  const start = minutesFromTime(startTime, "00:00");
  const end = Math.max(start, minutesFromTime(endTime, startTime));
  return timeFromMinutes(start + Math.floor(random() * (end - start + 1)));
}

function reminderLeadMinutes(settings) {
  const lead = Number(
    settings.whatsappReminderLeadMinutes ??
      DEFAULT_WHATSAPP_SETTINGS.whatsappReminderLeadMinutes,
  );
  if (!Number.isFinite(lead))
    return DEFAULT_WHATSAPP_SETTINGS.whatsappReminderLeadMinutes;
  return Math.max(1, Math.min(60, Math.round(lead)));
}

function settingTime(settings, key) {
  return normalizeTime(settings[key], DEFAULT_WHATSAPP_SETTINGS[key]);
}

function targetWindow(settings, action) {
  if (action === "clock-in") {
    return {
      start: settingTime(settings, "whatsappClockInTargetStartTime"),
      end: settingTime(settings, "whatsappClockInTargetEndTime"),
    };
  }
  return {
    start: settingTime(settings, "whatsappClockOutTargetStartTime"),
    end: settingTime(settings, "whatsappClockOutTargetEndTime"),
  };
}

export function buildDailyReminderState(
  settings = {},
  previousState = {},
  now = new Date(),
  random = Math.random,
) {
  const dateKey = localDateKey(now);
  if (
    previousState?.dateKey === dateKey &&
    previousState.dailyTargets &&
    previousState.dailyReminderTimes &&
    previousState.remindersSent
  ) {
    return previousState;
  }

  const dailyTargets = {};
  const dailyReminderTimes = {};
  const remindersSent = {};
  const lead = reminderLeadMinutes(settings);

  for (const action of ACTIONS) {
    const window = targetWindow(settings, action);
    const target = randomTargetInWindow(window.start, window.end, random);
    dailyTargets[action] = target;
    dailyReminderTimes[action] = timeFromMinutes(
      minutesFromTime(target) - lead,
    );
    remindersSent[action] = false;
  }

  return { dateKey, dailyTargets, dailyReminderTimes, remindersSent };
}

export function isReminderDue(currentTime, reminderTime) {
  const current = minutesFromTime(currentTime, "00:00");
  const reminder = minutesFromTime(reminderTime, "00:00");
  return current >= reminder && current <= reminder + 1;
}

export function getDueReminders(
  settings = {},
  previousState = {},
  now = new Date(),
  random = Math.random,
) {
  const state = structuredClone(
    buildDailyReminderState(settings, previousState, now, random),
  );
  const reminders = [];

  if (!settings.whatsappReminderEnabled) return { state, reminders };

  const current = currentLocalTime(now);
  for (const action of ACTIONS) {
    if (
      !state.remindersSent[action] &&
      isReminderDue(current, state.dailyReminderTimes[action])
    ) {
      state.remindersSent[action] = true;
      reminders.push({
        action,
        targetTime: state.dailyTargets[action],
        reminderTime: state.dailyReminderTimes[action],
      });
    }
  }

  return { state, reminders };
}

export function parseWhatsappCommand(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalized) return { type: "empty" };
  if (["help", "menu", "?"].includes(normalized)) return { type: "help" };
  if (["status", "cek", "session"].includes(normalized))
    return { type: "status" };

  const clockIn = normalized.match(
    /^(?:clock in|check in|ci)(?:\s+(random|photo\s+\d+))?$/,
  );
  if (clockIn) {
    const option = clockIn[1] || "";
    return {
      type: "clock-in",
      useRandomPhoto: option === "random",
      photoId: option.startsWith("photo ") ? option.split(" ")[1] : "",
    };
  }

  if (/^(?:clock out|check out|co)$/.test(normalized))
    return { type: "clock-out" };
  return { type: "unknown" };
}

export function extractMessageText(message) {
  const content = message?.message || {};
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

export function formatReminderMessage(reminder) {
  return [
    `Reminder ${ACTION_LABELS[reminder.action]} HRIS.`,
    `Target sekitar ${reminder.targetTime}.`,
    `Kirim: ${reminder.action === "clock-in" ? "clock in" : "clock out"}`,
    "Tidak ada submit otomatis.",
  ].join("\n");
}

function helpMessage() {
  return [
    "HRIS WhatsApp commands:",
    "status",
    "clock in",
    "clock in random",
    "clock in photo <id>",
    "clock out",
    "help",
    "",
    "Submit HRIS hanya berjalan setelah command eksplisit dari nomor WhatsApp yang terdaftar di aplikasi.",
  ].join("\n");
}

async function resolveClockInPhoto(command, settings, deps) {
  if (command.photoId) {
    const photo = deps.getPhoto ? await deps.getPhoto(command.photoId) : null;
    if (!photo) return { error: `Foto #${command.photoId} tidak ditemukan.` };
    return { photoId: String(photo.id) };
  }

  if (command.useRandomPhoto || settings.randomPhotoEnabled) {
    const photos = deps.listPhotos ? await deps.listPhotos() : [];
    if (!photos.length)
      return { error: "Belum ada foto tersimpan untuk clock-in random." };
    const photo = photos[Math.floor(Math.random() * photos.length)];
    return { photoId: String(photo.id) };
  }

  if (settings.selectedPhotoId) {
    const photo = deps.getPhoto
      ? await deps.getPhoto(settings.selectedPhotoId)
      : null;
    if (!photo)
      return {
        error: `Foto terpilih #${settings.selectedPhotoId} tidak ditemukan.`,
      };
    return { photoId: String(photo.id) };
  }

  return {
    error:
      "Belum ada foto untuk clock-in. Pakai `clock in random` atau `clock in photo <id>`.",
  };
}

function formatStatus(session, dashboard) {
  if (!session.loggedIn)
    return "HRIS status:\nSession: belum login. Login dulu dari aplikasi lokal.";
  return [
    "HRIS status:",
    "Session: logged in",
    `Status: ${dashboard.attendanceStatusLabel || "-"}`,
    `Clock-in: ${dashboard.clockInAt || "-"}`,
    `Can clock-out: ${dashboard.canClockOut ? "yes" : "no"}`,
  ].join("\n");
}

export async function handleWhatsappCommand({
  senderJid,
  text,
  settings,
  deps,
  authorized = false,
}) {
  if (
    !authorized &&
    !isAuthorizedSender(senderJid, settings.whatsappAuthorizedSenders)
  )
    return null;

  const command = parseWhatsappCommand(text);
  if (command.type === "empty") return null;
  if (command.type === "help") return helpMessage();

  if (command.type === "status") {
    const session = await deps.getSessionStatus();
    const dashboard = session.loggedIn ? await deps.getDashboardStatus() : {};
    return formatStatus(session, dashboard);
  }

  if (command.type === "clock-in") {
    const photo = await resolveClockInPhoto(command, settings, deps);
    if (photo.error) return photo.error;
    const payload = await deps.lakukanHalKeren({ photoId: photo.photoId });
    return `Clock-in sukses.\n${JSON.stringify(payload, null, 2)}`;
  }

  if (command.type === "clock-out") {
    const payload = await deps.lakukanHalTidakKeren({});
    return `Clock-out sukses.\n${JSON.stringify(payload, null, 2)}`;
  }

  return null;
}

export async function sendReminders({
  socket,
  settings,
  deps,
  now = new Date(),
  random = Math.random,
}) {
  const groupJid = normalizeGroupJid(settings.whatsappGroupJid);
  if (!settings.whatsappReminderEnabled || !groupJid) return;

  const previousState = (await deps.readState(WHATSAPP_BOT_STATE_KEY)) || {};
  const { state, reminders } = getDueReminders(
    settings,
    previousState,
    now,
    random,
  );
  const changed = JSON.stringify(state) !== JSON.stringify(previousState);

  if (reminders.length) {
    for (const reminder of reminders) {
      await socket.sendMessage(groupJid, {
        text: formatReminderMessage(reminder),
      });
    }
  }

  if (changed) await deps.writeState(WHATSAPP_BOT_STATE_KEY, state);
}

function shouldReconnect(lastDisconnect) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  return statusCode !== DisconnectReason.loggedOut;
}

export async function startWhatsappBot(deps) {
  const authDir = path.join(deps.dataDir, "baileys-auth");
  let socket = null;
  let stopped = false;
  let reminderTimer = null;
  const loggedGroupJids = new Set();

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    socket = makeWASocket({
      auth: state,
      browser: ["HRIS Helper", "Chrome", "1.0.0"],
      logger: pino({ level: "silent" }),
    });

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", (update) => {
      if (update.qr) qrcode.generate(update.qr, { small: true });
      if (update.connection === "open") console.log("WhatsApp bot connected.");
      if (
        update.connection === "close" &&
        !stopped &&
        shouldReconnect(update.lastDisconnect)
      ) {
        console.log("WhatsApp bot disconnected, reconnecting...");
        connect().catch((error) =>
          console.error(`WhatsApp reconnect failed: ${error.message}`),
        );
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages || []) {
        const remoteJid = message.key?.remoteJid || "";
        if (
          !remoteJid ||
          remoteJid === "status@broadcast" ||
          message.key?.fromMe
        )
          continue;
        if (!remoteJid.endsWith("@g.us")) continue;

        const text = extractMessageText(message);
        if (!text) continue;

        try {
          const groupJid = normalizeGroupJid(remoteJid);
          const senderJid = message.key?.participant || "";
          const resolvedSenderJid = await resolveParticipantSenderJid(
            socket,
            senderJid,
          );
          const command = parseWhatsappCommand(text);
          const target = deps.resolveSender
            ? await deps.resolveSender(resolvedSenderJid, groupJid)
            : { type: "matched", settings: await deps.readSettings(), deps };
          logGroupMessageDebug({
            groupJid,
            remoteJid,
            senderJid,
            resolvedSenderJid,
            normalizedPhone: normalizeWhatsappPhone(resolvedSenderJid),
            command: command.type,
            routing: target.type,
            matchedUserId: target.user?.id || null,
            text,
          });
          if (target.type === "ignored") {
            if (groupJid && !loggedGroupJids.has(groupJid)) {
              loggedGroupJids.add(groupJid);
              console.log(`WhatsApp group detected: ${groupJid}`);
            }
            continue;
          }
          if (target.type === "none") {
            if (!["empty", "unknown"].includes(command.type)) {
              await socket.sendMessage(remoteJid, {
                text: "Nomor WhatsApp kamu belum terdaftar di aplikasi.",
              });
            }
            continue;
          }
          if (target.type === "conflict") {
            await socket.sendMessage(remoteJid, {
              text: "Nomor WhatsApp ini terhubung ke lebih dari satu user aplikasi. Hapus duplikat nomor dulu.",
            });
            continue;
          }
          const reply = await handleWhatsappCommand({
            senderJid: resolvedSenderJid,
            text,
            settings: target.settings,
            deps: target.deps || deps,
            authorized: true,
          });
          if (reply) await socket.sendMessage(remoteJid, { text: reply });
        } catch (error) {
          await socket.sendMessage(remoteJid, {
            text: `HRIS bot error: ${error.message}`,
          });
        }
      }
    });
  }

  await connect();
  reminderTimer = setInterval(async () => {
    try {
      if (deps.listReminderTargets) {
        const targets = await deps.listReminderTargets();
        for (const target of targets) {
          if (target.settings.whatsappBotEnabled) {
            await sendReminders({
              socket,
              settings: target.settings,
              deps: target.deps,
            });
          }
        }
        return;
      }

      const settings = await deps.readSettings();
      if (!settings.whatsappBotEnabled) return;
      await sendReminders({ socket, settings, deps });
    } catch (error) {
      console.error(`WhatsApp reminder failed: ${error.message}`);
    }
  }, 30000);

  return {
    async sendMessage(jid, message) {
      if (!socket) throw new Error("WhatsApp bot belum terkoneksi.");
      return socket.sendMessage(jid, message);
    },
    async stop() {
      stopped = true;
      if (reminderTimer) clearInterval(reminderTimer);
      if (socket?.end) socket.end(undefined);
      else if (socket?.ws?.close) socket.ws.close();
    },
  };
}

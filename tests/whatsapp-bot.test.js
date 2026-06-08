import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDailyReminderState,
  getDueReminders,
  handleWhatsappCommand,
  normalizeAuthorizedSenders,
  normalizeGroupJid,
  normalizeSenderJid,
  normalizeWhatsappPhone,
  parseWhatsappCommand,
  resolveWhatsappPhoneUser,
  resolveWhatsappSenderUser,
  sendReminders,
} from '../lib/whatsapp-bot.js';

test('normalizes WhatsApp sender IDs', () => {
  assert.equal(normalizeSenderJid('+62 812-3456-789'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeSenderJid('628123456789@s.whatsapp.net'), '628123456789@s.whatsapp.net');
  assert.deepEqual(normalizeAuthorizedSenders(['+62 812', '62812@s.whatsapp.net', '']), ['62812@s.whatsapp.net']);
});

test('normalizes WhatsApp phone numbers and group IDs', () => {
  assert.equal(normalizeWhatsappPhone('+62 812-3456-789'), '628123456789');
  assert.equal(normalizeWhatsappPhone('628123456789@s.whatsapp.net'), '628123456789');
  assert.equal(normalizeGroupJid('120363123456@g.us'), '120363123456@g.us');
  assert.equal(normalizeGroupJid(' 120363123456 '), '120363123456@g.us');
  assert.equal(normalizeGroupJid('12345-67890@g.us'), '12345-67890@g.us');
});

test('routes WhatsApp sender to exactly one app user', () => {
  const users = [
    { user: { id: 1 }, settings: { whatsappAuthorizedSenders: ['+628111'] } },
    { user: { id: 2 }, settings: { whatsappAuthorizedSenders: ['+628222'] } },
  ];

  const resolved = resolveWhatsappSenderUser('628222@s.whatsapp.net', users);

  assert.equal(resolved.type, 'matched');
  assert.equal(resolved.user.id, 2);
});

test('rejects duplicate WhatsApp sender ownership', () => {
  const users = [
    { user: { id: 1 }, settings: { whatsappAuthorizedSenders: ['+628111'] } },
    { user: { id: 2 }, settings: { whatsappAuthorizedSenders: ['628111@s.whatsapp.net'] } },
  ];

  const resolved = resolveWhatsappSenderUser('+628111', users);

  assert.equal(resolved.type, 'conflict');
  assert.deepEqual(resolved.matches.map((item) => item.user.id), [1, 2]);
});

test('ignores unmatched WhatsApp sender', () => {
  const resolved = resolveWhatsappSenderUser('+628333', [
    { user: { id: 1 }, settings: { whatsappAuthorizedSenders: ['+628111'] } },
  ]);

  assert.equal(resolved.type, 'none');
});

test('routes group participant phone to exactly one app user', () => {
  const users = [
    { user: { id: 1, whatsappPhoneNumber: '+628111' }, settings: {} },
    { user: { id: 2, whatsappPhoneNumber: '628222' }, settings: {} },
  ];

  const resolved = resolveWhatsappPhoneUser('628222@s.whatsapp.net', users);

  assert.equal(resolved.type, 'matched');
  assert.equal(resolved.user.id, 2);
  assert.equal(resolved.phoneNumber, '628222');
});

test('rejects duplicate WhatsApp phone ownership', () => {
  const users = [
    { user: { id: 1, whatsappPhoneNumber: '+628111' }, settings: {} },
    { user: { id: 2, whatsappPhoneNumber: '628111' }, settings: {} },
  ];

  const resolved = resolveWhatsappPhoneUser('+628111', users);

  assert.equal(resolved.type, 'conflict');
  assert.deepEqual(resolved.matches.map((item) => item.user.id), [1, 2]);
});

test('ignores unmatched WhatsApp participant phone', () => {
  const resolved = resolveWhatsappPhoneUser('+628333', [
    { user: { id: 1, whatsappPhoneNumber: '+628111' }, settings: {} },
  ]);

  assert.equal(resolved.type, 'none');
});

test('parses WhatsApp bot commands', () => {
  assert.deepEqual(parseWhatsappCommand('help'), { type: 'help' });
  assert.deepEqual(parseWhatsappCommand('cek'), { type: 'status' });
  assert.deepEqual(parseWhatsappCommand('clock in'), { type: 'clock-in', useRandomPhoto: false, photoId: '' });
  assert.deepEqual(parseWhatsappCommand('ci random'), { type: 'clock-in', useRandomPhoto: true, photoId: '' });
  assert.deepEqual(parseWhatsappCommand('clock in photo 12'), { type: 'clock-in', useRandomPhoto: false, photoId: '12' });
  assert.deepEqual(parseWhatsappCommand('co'), { type: 'clock-out' });
  assert.deepEqual(parseWhatsappCommand('wat'), { type: 'unknown' });
});

test('daily reminder state uses configured target windows and lead time', () => {
  const state = buildDailyReminderState({
    whatsappReminderLeadMinutes: 5,
    whatsappClockInTargetStartTime: '08:55',
    whatsappClockInTargetEndTime: '09:10',
    whatsappClockOutTargetStartTime: '17:55',
    whatsappClockOutTargetEndTime: '18:10',
  }, {}, new Date(2026, 5, 8, 8, 0), () => 0);

  assert.equal(state.dailyTargets['clock-in'], '08:55');
  assert.equal(state.dailyReminderTimes['clock-in'], '08:50');
  assert.equal(state.dailyTargets['clock-out'], '17:55');
  assert.equal(state.dailyReminderTimes['clock-out'], '17:50');
  assert.equal(state.remindersSent['clock-in'], false);
});

test('reminder due calculation sends each action once per day', () => {
  const settings = {
    whatsappReminderEnabled: true,
    whatsappReminderLeadMinutes: 5,
    whatsappClockInTargetStartTime: '08:55',
    whatsappClockInTargetEndTime: '08:55',
    whatsappClockOutTargetStartTime: '17:55',
    whatsappClockOutTargetEndTime: '17:55',
  };
  const first = getDueReminders(settings, {}, new Date(2026, 5, 8, 8, 50));
  const second = getDueReminders(settings, first.state, new Date(2026, 5, 8, 8, 50));

  assert.deepEqual(first.reminders.map((item) => item.action), ['clock-in']);
  assert.deepEqual(second.reminders, []);
});

test('unauthorized WhatsApp command does not trigger submission', async () => {
  let submitted = false;
  const reply = await handleWhatsappCommand({
    senderJid: '628999@s.whatsapp.net',
    text: 'clock in',
    settings: { whatsappAuthorizedSenders: ['628111'] },
    deps: {
      storeClockIn: async () => {
        submitted = true;
      },
    },
  });

  assert.equal(reply, null);
  assert.equal(submitted, false);
});

test('authorized explicit clock-in command submits once with selected photo', async () => {
  const calls = [];
  const reply = await handleWhatsappCommand({
    senderJid: '628111@s.whatsapp.net',
    text: 'clock in',
    settings: { whatsappAuthorizedSenders: ['+628111'], selectedPhotoId: '7' },
    deps: {
      getPhoto: async (id) => ({ id }),
      storeClockIn: async (payload) => {
        calls.push(payload);
        return { ok: true };
      },
    },
  });

  assert.deepEqual(calls, [{ photoId: '7' }]);
  assert.match(reply, /Clock-in sukses/);
});

test('pre-authorized group command submits without sender allowlist', async () => {
  const calls = [];
  const reply = await handleWhatsappCommand({
    senderJid: '628111@s.whatsapp.net',
    text: 'clock out',
    settings: { whatsappAuthorizedSenders: [] },
    authorized: true,
    deps: {
      storeClockOut: async (payload) => {
        calls.push(payload);
        return { ok: true };
      },
    },
  });

  assert.deepEqual(calls, [{}]);
  assert.match(reply, /Clock-out sukses/);
});

test('authorized explicit clock-out command submits once', async () => {
  const calls = [];
  const reply = await handleWhatsappCommand({
    senderJid: '628111@s.whatsapp.net',
    text: 'clock out',
    settings: { whatsappAuthorizedSenders: ['+628111'] },
    deps: {
      storeClockOut: async (payload) => {
        calls.push(payload);
        return { ok: true };
      },
    },
  });

  assert.deepEqual(calls, [{}]);
  assert.match(reply, /Clock-out sukses/);
});

test('reminder tick sends group WhatsApp reminder without submitting attendance', async () => {
  const sent = [];
  let submitted = false;
  let savedState = null;
  const settings = {
    whatsappReminderEnabled: true,
    whatsappGroupJid: '120363123456@g.us',
    whatsappReminderLeadMinutes: 5,
    whatsappClockInTargetStartTime: '08:55',
    whatsappClockInTargetEndTime: '08:55',
    whatsappClockOutTargetStartTime: '17:55',
    whatsappClockOutTargetEndTime: '17:55',
  };

  await sendReminders({
    socket: {
      sendMessage: async (jid, message) => sent.push({ jid, message }),
    },
    settings,
    deps: {
      readState: async () => ({}),
      writeState: async (_key, value) => {
        savedState = value;
      },
      storeClockIn: async () => {
        submitted = true;
      },
      storeClockOut: async () => {
        submitted = true;
      },
    },
    now: new Date(2026, 5, 8, 8, 50),
  });

  assert.equal(submitted, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '120363123456@g.us');
  assert.match(sent[0].message.text, /Reminder clock-in HRIS/);
  assert.equal(savedState.remindersSent['clock-in'], true);
});

test('reminder tick skips sending when group JID is empty', async () => {
  const sent = [];
  let savedState = null;

  await sendReminders({
    socket: {
      sendMessage: async (jid, message) => sent.push({ jid, message }),
    },
    settings: {
      whatsappReminderEnabled: true,
      whatsappGroupJid: '',
      whatsappReminderLeadMinutes: 5,
      whatsappClockInTargetStartTime: '08:55',
      whatsappClockInTargetEndTime: '08:55',
      whatsappClockOutTargetStartTime: '17:55',
      whatsappClockOutTargetEndTime: '17:55',
    },
    deps: {
      readState: async () => ({}),
      writeState: async (_key, value) => {
        savedState = value;
      },
    },
    now: new Date(2026, 5, 8, 8, 50),
  });

  assert.deepEqual(sent, []);
  assert.equal(savedState, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { validateAction, decodeAction, tehranDay, sendDailyReminder } from '../src/index.ts';

// Node.js 24+; the SQLite experimental warning is expected on some versions.
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_init.sql', '0002_assistant_state.sql', '0003_delivery_state.sql', '0004_daily_reminders.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const adapter = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  let output = { action: 'list' };
  const calls = [];
  const env = {
    DB: adapter,
    AI: { async run(...args) { calls.push(args); return { response: typeof output === 'string' ? output : JSON.stringify(output) }; } },
    TELEGRAM_BOT_TOKEN: 'test-only-not-a-real-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    ALLOWED_TELEGRAM_ID: '12345',
    AI_MODEL: 'test-model',
  };
  const request = (id = 1, text = 'کارام چیه', overrides = {}) => new Request('https://example.test/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
    body: JSON.stringify({ update_id: id, message: { from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text }, ...overrides }),
  });
  return { sqlite, env, request, calls, output(value) { output = value; } };
}

async function withTelegram(fn) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'));
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  };
  try { await fn(sent); } finally { globalThis.fetch = original; }
}

test('Tehran day crosses UTC midnight boundary correctly', () => {
  assert.equal(tehranDay(new Date('2026-11-17T20:29:59Z')), '2026-11-17');
  assert.equal(tehranDay(new Date('2026-11-17T20:30:00Z')), '2026-11-18');
});

test('strict action validation', () => {
  assert.deepEqual(validateAction({ action: 'add', text: ' شیر ' }, 0), { action: 'add', text: 'شیر' });
  for (const value of [null, [], { action: 'drop' }, { action: 'list', sql: 'DROP TABLE tasks' },
    { action: 'add', text: '' }, { action: 'add', text: 'x'.repeat(301) },
    { action: 'done', numbers: [0] }, { action: 'done', numbers: [3] },
    { action: 'done', numbers: [1, 1] }, { action: 'done', numbers: [1.5] },
    { action: 'del', numbers: [1, 2] }, { action: 'chat', reply: '' },
    { action: 'done', numbers: [] }]) assert.equal(validateAction(value, 2), null);
  assert.deepEqual(validateAction({ action: 'del', numbers: [2] }, 2), { action: 'del', numbers: [2] });
});

test('model output accepts a JSON object, JSON text or one fenced JSON block', () => {
  for (const value of [{ action: 'list' }, '{"action":"list"}', '```json\n{"action":"list"}\n```']) {
    assert.deepEqual(decodeAction(value, 0), { action: 'list' });
  }
});

test('malformed, mixed or disallowed model output is rejected', () => {
  for (const value of ['oops', 'نتیجه:\n```json\n{"action":"list"}\n```', '```json\n{"action":"list","extra":1}\n```',
    '```json\n{"action":"del","numbers":[1]}\n```', {}, 'x'.repeat(8001), undefined]) {
    assert.equal(decodeAction(value, 0), null);
  }
});

test('health route works without secrets', async () => {
  const r = await worker.fetch(new Request('https://example.test/health'), {});
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('unsigned and incorrectly signed webhooks get 403', async () => {
  const { env } = setup();
  for (const headers of [{}, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }]) {
    const r = await worker.fetch(new Request('https://example.test/webhook', { method: 'POST', headers, body: '{}' }), env);
    assert.equal(r.status, 403);
  }
});

test('empty whitelist fails closed', async () => {
  const { env, request } = setup();
  env.ALLOWED_TELEGRAM_ID = '';
  assert.equal((await worker.fetch(request(), env)).status, 503);
});

test('other users and groups are silently ignored', async () => {
  const { env, request, calls, sqlite } = setup();
  for (const message of [
    { from: { id: 999 }, chat: { id: 999, type: 'private' }, text: 'سلام' },
    { from: { id: 12345 }, chat: { id: -100, type: 'group' }, text: 'سلام' },
  ]) assert.equal((await worker.fetch(request(1, '', { message }), env)).status, 200);
  assert.equal(calls.length, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM processed_updates').get().n, 0);
});

test('add persists once and duplicate update does not rerun AI', async () => withTelegram(async sent => {
  const { env, request, output, sqlite, calls } = setup();
  output({ action: 'add', text: 'خرید شیر' });
  assert.equal((await worker.fetch(request(10, 'شیر بخر'), env)).status, 200);
  assert.equal((await worker.fetch(request(10, 'شیر بخر'), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
}));

test('webhook answers a Persian list request with fenced JSON from the model', async () => withTelegram(async sent => {
  const { env, request, output } = setup();
  output('```json\n{"action":"list"}\n```');
  assert.equal((await worker.fetch(request(11, 'فهرست کارهای امروز را نشان بده'), env)).status, 200);
  assert.match(sent[0].text, /برای امروز کاری ثبت نشده/);
}));

test('daily progress uses only today’s tasks and never calls AI or changes tasks', async () => withTelegram(async sent => {
  const { env, request, sqlite, calls } = setup();
  assert.equal((await worker.fetch(request(1, 'نبض امروز'), env)).status, 200);
  assert.match(sent[0].text, /برای امروز کاری ثبت نشده/);
  const insert = sqlite.prepare('INSERT INTO tasks (text, day, done, created_at) VALUES (?, ?, ?, ?)');
  const now = new Date();
  insert.run('یک کار انجام شده', tehranDay(now), 1, now.getTime());
  insert.run('یک کار باقی مانده', tehranDay(now), 0, now.getTime());
  insert.run('کار روز دیگر', '2000-01-01', 0, now.getTime());
  const before = sqlite.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.equal((await worker.fetch(request(2, 'چند تا كار مونده؟'), env)).status, 200);
  assert.equal((await worker.fetch(request(2, 'چند تا كار مونده؟'), env)).status, 200);
  assert.match(sent[1].text, /🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜/);
  assert.match(sent[1].text, /۱ از ۲ کار انجام شده \(۵۰٪\)/);
  assert.match(sent[1].text, /۱ کار باقی مانده/);
  assert.equal(sent.length, 2);
  assert.equal(calls.length, 0);
  assert.deepEqual(sqlite.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
}));

test('invalid model output causes no task mutation', async () => withTelegram(async sent => {
  const { env, request, output, sqlite } = setup();
  output('not JSON');
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.match(sent[0].text, /هیچ کاری تغییر نکرد/);
}));

test('done, undone and del use current-day numbered tasks', async () => withTelegram(async () => {
  const { env, request, output, sqlite } = setup();
  output({ action: 'add', text: 'شیر' });
  await worker.fetch(request(1, 'شیر بخر'), env);
  output({ action: 'done', numbers: [1] });
  await worker.fetch(request(2, 'شیر خریدم'), env);
  assert.equal(sqlite.prepare('SELECT done FROM tasks').get().done, 1);
  output({ action: 'undone', numbers: [1] });
  await worker.fetch(request(3, 'هنوز نخریدم'), env);
  assert.equal(sqlite.prepare('SELECT done FROM tasks').get().done, 0);
  output({ action: 'del', numbers: [1] });
  await worker.fetch(request(4, 'شیر رو حذف کن'), env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
}));

test('bulk delete and invalid task reference do not mutate tasks', async () => withTelegram(async () => {
  const { env, request, output, sqlite } = setup();
  for (const id of [1, 2]) {
    output({ action: 'add', text: `کار ${id}` });
    await worker.fetch(request(id), env);
  }
  output({ action: 'del', numbers: [1, 2] });
  await worker.fetch(request(3, 'همه را حذف کن'), env);
  output({ action: 'done', numbers: [999] });
  await worker.fetch(request(4), env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);
  assert.equal(sqlite.prepare('SELECT SUM(done) AS n FROM tasks').get().n, 0);
}));

test('short memory is bounded and supplied on the next model call', async () => withTelegram(async () => {
  const { env, request, output, sqlite, calls } = setup();
  output({ action: 'chat', reply: 'سلام!' });
  for (let id = 1; id <= 5; id++) await worker.fetch(request(id, `سلام ${id}`), env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get().n, 6);
  assert.ok(calls[4][1].messages.some(m => m.content === 'سلام 4'));
}));

test('Telegram failure retries stored reply, not the task mutation', async () => {
  const original = globalThis.fetch;
  const { env, request, output, sqlite, calls } = setup();
  output({ action: 'add', text: 'شیر' });
  try {
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    assert.equal((await worker.fetch(request(1), env)).status, 503);
    assert.equal(sqlite.prepare('SELECT status FROM processed_updates').get().status, 'completed');
    globalThis.fetch = async () => Response.json({ ok: true });
    assert.equal((await worker.fetch(request(1), env)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
    assert.equal(sqlite.prepare('SELECT delivered FROM processed_updates').get().delivered, 1);
  } finally { globalThis.fetch = original; }
});

test('active duplicate returns retry; expired lease can recover', async () => withTelegram(async () => {
  const { env, request, sqlite, output, calls } = setup();
  const now = Date.now();
  sqlite.prepare(`INSERT INTO processed_updates (update_id, status, created_at, updated_at, claim_token)
    VALUES (1, 'processing', ?, ?, 'another-handler')`).run(now, now);
  assert.equal((await worker.fetch(request(1), env)).status, 503);
  assert.equal(calls.length, 0);
  sqlite.prepare('UPDATE processed_updates SET updated_at = ?').run(now - 600000);
  output({ action: 'add', text: 'شیر' });
  assert.equal((await worker.fetch(request(1), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
}));

test('reminder is silent before Tehran target hour', async () => withTelegram(async sent => {
  const { env, sqlite, calls } = setup();
  await sendDailyReminder(env, new Date('2026-11-17T04:29:00Z'));
  assert.equal(sent.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_reminders').get().n, 0);
}));

test('8 AM Tehran reminder sends once per day and uses no AI', async () => withTelegram(async sent => {
  const { env, sqlite, calls } = setup();
  sqlite.prepare('INSERT INTO tasks (text, day, created_at) VALUES (?, ?, ?)').run('خرید شیر', '2026-11-17', 1);
  await sendDailyReminder(env, new Date('2026-11-17T04:30:00Z'));
  await sendDailyReminder(env, new Date('2026-11-17T04:31:00Z'));
  await sendDailyReminder(env, new Date('2026-11-17T05:29:00Z'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 12345);
  assert.match(sent[0].text, /خرید شیر/);
  assert.equal(calls.length, 0);
  assert.equal(sqlite.prepare('SELECT status FROM daily_reminders').get().status, 'sent');
  await sendDailyReminder(env, new Date('2026-11-18T04:30:00Z'));
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /برای امروز کاری ثبت نشده/);
}));

test('failed reminder can retry on next cron without an AI call', async () => {
  const { env, sqlite, calls } = setup();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(sendDailyReminder(env, new Date('2026-11-17T04:30:00Z')), /daily_reminder_failed/);
    assert.equal(sqlite.prepare('SELECT status FROM daily_reminders').get().status, 'failed');
    globalThis.fetch = async () => Response.json({ ok: true });
    await sendDailyReminder(env, new Date('2026-11-17T04:31:00Z'));
    assert.equal(sqlite.prepare('SELECT status FROM daily_reminders').get().status, 'sent');
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = original; }
});

test('reminder honors configured Tehran hour and fails closed without whitelist', async () => withTelegram(async sent => {
  const { env } = setup();
  env.REMINDER_HOUR = '9';
  await sendDailyReminder(env, new Date('2026-11-17T04:30:00Z'));
  assert.equal(sent.length, 0);
  env.ALLOWED_TELEGRAM_ID = '';
  await assert.rejects(sendDailyReminder(env, new Date('2026-11-17T05:30:00Z')), /reminder_not_configured/);
  assert.equal(sent.length, 0);
}));

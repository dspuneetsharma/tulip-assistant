'use strict';
const test = require('node:test');
const assert = require('node:assert');

let helpers, limits;
test.before(async () => { try { helpers = await import('./helpers/worker_env.mjs'); limits = await import('../worker/limits.mjs'); } catch (e) { if (!/sqlite/i.test(String(e && e.message))) throw e; } });
const skip = !(() => { try { require('node:sqlite'); return true; } catch (_) { return false; } })() && 'node:sqlite is not available in this Node version';

const T0 = Date.UTC(2026, 9, 3, 10, 0, 0);
const mk = (l) => { const { LimitStore, DEFAULT_LIMITS } = limits; const db = new (require('node:sqlite').DatabaseSync)(':memory:'); return { db, store: new LimitStore(helpers.sqlShim(db), { ...DEFAULT_LIMITS, ...l }) }; };

test('per-visitor minute limit: blocks the 7th request, reports a retry time, frees up as the window passes', { skip }, async () => {
  const { store } = mk({});
  for (let i = 0; i < 6; i++) assert.ok((await store.admit('1.1.1.1', T0 + i * 1000)).ok);
  const r = await store.admit('1.1.1.1', T0 + 10000);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'rate_minute');
  assert.ok(r.retryAfter >= 40 && r.retryAfter <= 51, 'retryAfter ' + r.retryAfter);
  assert.ok((await store.admit('1.1.1.1', T0 + 61500)).ok);
});

test('limits are per visitor: another IP is unaffected', { skip }, async () => {
  const { store } = mk({});
  for (let i = 0; i < 6; i++) await store.admit('1.1.1.1', T0 + i);
  assert.strictEqual((await store.admit('1.1.1.1', T0 + 100)).ok, false);
  assert.ok((await store.admit('2.2.2.2', T0 + 100)).ok);
});

test('hour and day limits apply', { skip }, async () => {
  const { store } = mk({ perMinute: 1000, perHour: 5, perDay: 8 });
  for (let i = 0; i < 5; i++) assert.ok((await store.admit('9.9.9.9', T0 + i * 1000)).ok);
  assert.strictEqual((await store.admit('9.9.9.9', T0 + 6000)).reason, 'rate_hour');
  for (let i = 0; i < 3; i++) assert.ok((await store.admit('9.9.9.9', T0 + 3600001 + i * 1000)).ok);
  const r = await store.admit('9.9.9.9', T0 + 3600001 + 5000);
  assert.strictEqual(r.reason, 'rate_day');
});

test('global daily Neuron budget: reservation, settlement with the measured figure, then refusal; resets next UTC day', { skip }, async () => {
  const { store } = mk({ dailyNeuronCap: 250, reserveNeurons: 100, perMinute: 1000 });
  const a = await store.admit('a', T0); assert.ok(a.ok);
  store.settle(a.day, 60);                       // measured 60, not the 100 reserved
  assert.strictEqual(store.status(T0).neurons, 60);
  assert.ok((await store.admit('b', T0 + 1)).ok);  // 60 used + 100 reserved <= 250; now 160 counted
  const d = await store.admit('d', T0 + 3);   // 160 + 100 reserved > 250
  assert.strictEqual(d.ok, false); assert.strictEqual(d.reason, 'daily_limit');
  assert.ok(d.retryAfter > 0 && d.retryAfter <= 86400);
  assert.ok((await store.admit('d', T0 + 24 * 3600 * 1000)).ok);   // next UTC day
});

test('global request cap and markExhausted both stop the day', { skip }, async () => {
  const a = mk({ dailyRequestCap: 3, perMinute: 1000 });
  for (let i = 0; i < 3; i++) assert.ok((await a.store.admit('x' + i, T0 + i)).ok);
  assert.strictEqual((await a.store.admit('y', T0 + 10)).reason, 'daily_limit');
  const b = mk({ perMinute: 1000 });
  const adm = await b.store.admit('z', T0); b.store.markExhausted(adm.day);
  assert.strictEqual((await b.store.admit('z2', T0 + 5)).reason, 'daily_limit');
});

test('raw IP addresses are never stored', { skip }, async () => {
  const { store, db } = mk({});
  await store.admit('198.51.100.23', T0);
  const dump = JSON.stringify(db.prepare('SELECT * FROM hits').all()) + JSON.stringify(db.prepare('SELECT * FROM meta').all());
  assert.ok(!dump.includes('198.51.100.23'));
  const row = db.prepare('SELECT ip FROM hits').get();
  assert.match(row.ip, /^[0-9a-f]{32}$/);
});

test('blocked requests do not write rows', { skip }, async () => {
  const { store, db } = mk({ perMinute: 2 });
  await store.admit('k', T0); await store.admit('k', T0 + 1);
  const before = db.prepare('SELECT COUNT(*) c FROM hits').get().c;
  for (let i = 0; i < 20; i++) await store.admit('k', T0 + 2 + i);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM hits').get().c, before);
});

test('old rows are purged', { skip }, async () => {
  const { store, db } = mk({ perMinute: 1000 });
  await store.admit('p', T0);
  await store.admit('p', T0 + 2 * 86400000);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM hits').get().c, 1);
});

test('limits come from env vars with safe defaults', async () => {
  const { limitsFromEnv, DEFAULT_LIMITS } = limits;
  assert.deepStrictEqual(limitsFromEnv({}), { ...DEFAULT_LIMITS });
  assert.strictEqual(limitsFromEnv({ LIMIT_PER_MINUTE: '3' }).perMinute, 3);
  assert.strictEqual(limitsFromEnv({ LIMIT_PER_MINUTE: 'abc' }).perMinute, DEFAULT_LIMITS.perMinute);
  assert.ok(DEFAULT_LIMITS.dailyNeuronCap < 10000, 'cap must stay below the free daily allocation');
});

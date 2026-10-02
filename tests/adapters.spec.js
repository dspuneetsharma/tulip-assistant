'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cleanContent, extract, describeShape } = require('../src/adapters/parse.js');
const { ModelError } = require('../src/adapters/errors.js');
const { CloudflareAdapter } = require('../src/adapters/cloudflare.js');
const { observe, unrecordedNumbers } = require('../src/observations.js');
const { Ledger, estimateNeurons, BudgetError } = require('../src/ledger.js');
const cfg = require('../config/model.json');

test('reasoning blocks are removed from model output', () => {
  assert.deepStrictEqual(cleanContent('<think>private</think>Answer.').text, 'Answer.');
  const u = cleanContent('<think>never closed');
  assert.strictEqual(u.text, ''); assert.ok(u.info.unclosedThink);
  assert.strictEqual(cleanContent('hidden reasoning</think>Visible.').text, 'Visible.');
});

test('response extraction supports chat-completion, result-wrapped and plain shapes; reasoning is only measured', () => {
  const a = extract({ choices: [{ message: { content: 'Hi', reasoning_content: 'secret' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
  assert.strictEqual(a.content, 'Hi'); assert.strictEqual(a.reasoningChars, 6); assert.strictEqual(a.finishReason, 'stop'); assert.ok(a.usage);
  assert.strictEqual(extract({ result: { response: 'Plain' } }).content, 'Plain');
  assert.strictEqual(extract({ choices: [{ message: { content: [{ text: 'A' }, { text: 'B' }] } }] }).content, 'AB');
  assert.strictEqual(extract(null).content, '');
  assert.ok(!JSON.stringify(describeShape({ a: 'a long secret string' })).includes('secret'));
});

test('REST adapter: request body, endpoint and the no-think variant', () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'; process.env.CLOUDFLARE_API_TOKEN = 'token-value-123456';
  const a = new CloudflareAdapter(cfg, { variant: 'no_think_suffix', endpointStyle: 'openai' });
  const body = a.buildBody([{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], 100, 'no_think_suffix');
  assert.strictEqual(body.messages[1].content, 'q\n/no_think'); assert.strictEqual(body.model, cfg.model); assert.strictEqual(body.max_tokens, 100);
  assert.ok(a.url().endsWith('/ai/v1/chat/completions'));
  assert.ok(new CloudflareAdapter(cfg, { endpointStyle: 'run' }).url().includes('/ai/run/' + cfg.model));
});

test('REST adapter: error mapping without network (fetch is faked); the token is never in an error message', async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'; process.env.CLOUDFLARE_API_TOKEN = 'token-value-123456';
  const real = global.fetch;
  const reply = (status, body) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  try {
    const a = new CloudflareAdapter({ ...cfg, max_retries: 0 }, { variant: 'none' });
    global.fetch = reply(401, { success: false, errors: [{ message: 'bad token-value-123456' }] });
    await assert.rejects(() => a.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), (e) => e instanceof ModelError && e.kind === 'auth' && !e.message.includes('token-value-123456'));
    global.fetch = reply(429, { success: false, errors: [{ code: 4006, message: 'daily free allocation of neurons used up' }] });
    await assert.rejects(() => a.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }), (e) => e.kind === 'daily_limit' && e.retryable === false);
    global.fetch = reply(200, { choices: [{ message: { content: 'Fine.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    const r = await a.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
    assert.strictEqual(r.text, 'Fine.'); assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.usageReported, true);
  } finally { global.fetch = real; }
});

test('without credentials the REST adapter refuses before any request', async () => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN;
  const a = new CloudflareAdapter(cfg, { variant: 'none' });
  assert.strictEqual(a.hasCredentials(), false);
  await assert.rejects(() => a.complete({ messages: [], maxTokens: 1 }), (e) => e.kind === 'no_credentials');
});

test('usage estimate and local cap', () => {
  assert.ok(Math.abs(estimateNeurons(1e6, 0, { input: 4625, output: 30475 }) - 4625) < 1e-9);
  const l = new Ledger({ ...cfg, local_daily_cap_estimated_neurons: 10 }, { persist: false });
  assert.throws(() => l.check(100000, 450, null), BudgetError);
  const ok = new Ledger(cfg, { persist: false });
  assert.ok(ok.check(1000, 100, null) > 0);
  assert.throws(() => ok.check(1000, 100, 0.0001), /Run budget/);
  assert.ok(ok.record({ prompt_tokens: 1000, completion_tokens: 100 }) > 0 && ok.session.requests === 1);
});

test('observations: advisory notes only', () => {
  const kinds = (t, q) => observe(t, { question: q, facts: 'It ran for 12 weeks.' }).map((o) => o.kind);
  assert.ok(kinds('It ran for 99 weeks.', '').includes('numbers_not_in_facts'));
  assert.ok(!kinds('It ran for 12 weeks.', '').includes('numbers_not_in_facts'));
  assert.deepStrictEqual(unrecordedNumbers('Version 2 had 12 items and 45.', 'Is 45 right?', 'It had 12 items.'), []);
  assert.ok(kinds('The change helped to improve accuracy.', '').includes('causal_wording'));
  assert.ok(kinds('He did not use it.', '').includes('non_use_wording'));
  assert.ok(kinds('Alex Example did it. Alex Example said so. Alex Example agreed. Alex Example left.', '').includes('name_frequency'));
});

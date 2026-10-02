'use strict';
// The Worker bundle must be generated from exactly the supplied runtime knowledge, behave like the Node runtime, and contain nothing else.
// Tests build a bundle from the EXAMPLE knowledge base in a temporary folder; they never read or write a private bundle.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../src/guards.js');
const { loadRuntime } = require('../src/knowledge.js');
const { createSession, loadModelCfg } = require('../src/tulip.js');
const { MockAdapter } = require('../src/adapters/mock.js');
const { Ledger } = require('../src/ledger.js');
const build = require('../scripts/build_worker.js');
const { prepareWorker } = require('./helpers/worker_fixture.js');
const { exampleRuntime } = require('./helpers/example_runtime.js');

let W, runtimeDir, bundleText;
test.before(async () => {
  W = await prepareWorker();
  runtimeDir = exampleRuntime().runtimeDir;
  bundleText = fs.readFileSync(path.join(W.dir, 'worker', 'generated', 'tulip_core.mjs'), 'utf8');
});

test('generation is deterministic for the same runtime knowledge', () => {
  assert.strictEqual(build.generate({ runtimeDir }), build.generate({ runtimeDir }));
});

test('bundle knowledge equals what the Node runtime loads (hash-verified prompt + rules + facts)', () => {
  const k = loadRuntime(G.CFG.runtime_flags, { runtimeDir });
  assert.strictEqual(W.core.KNOWLEDGE.system, k.system);
  assert.strictEqual(W.core.KNOWLEDGE.facts, k.facts);
  assert.ok(W.core.BUILD_INFO.prompt_version);
  assert.ok(W.core.KNOWLEDGE.system.includes('message_saving=false'));
  assert.ok(W.core.KNOWLEDGE.system.includes('external_delivery=false'));
});

test('bundle contains only the allowlisted modules and no credentials, file access or excluded material', () => {
  assert.deepStrictEqual(W.core.BUILD_INFO.modules, [...build.SOURCE_MODULES, ...build.JSON_MODULES]);
  assert.ok(!/process\.env|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|api\.cloudflare\.com/.test(bundleText));
  const nodeReqs = [...new Set((bundleText.match(/__req\("node:[a-z:/]+"\)/g) || []))].sort();
  assert.deepStrictEqual(nodeReqs, ['__req("node:fs")', '__req("node:path")']);
});

test('a tampered runtime file is rejected at build time (hash mismatch)', () => {
  const bad = path.join(require('./helpers/example_runtime.js').tmp('assistant-bad-'), 'runtime');
  fs.cpSync(runtimeDir, bad, { recursive: true });
  fs.appendFileSync(path.join(bad, 'facts.md'), '\n- An unapproved extra line.\n');
  assert.throws(() => build.generate({ runtimeDir: bad }), /hash|manifest|verify|changed/i);
});

test('Worker ledger never touches the file system (persist:false)', () => {
  const l = new W.core.Ledger(W.core.MODEL_CFG, { persist: false });
  l.check(50000, 450, null); l.record({ prompt_tokens: 100, completion_tokens: 10 });
  assert.ok(l.session.est_neurons > 0);
});

test('bundled session behaves like the Node session on the same inputs (mock model)', async () => {
  const cfg = loadModelCfg();
  const knowledge = loadRuntime(G.CFG.runtime_flags, { runtimeDir });
  const reply = 'Alex Example has worked on forecasting and retrieval projects.';
  const questions = ['What projects has Alex Example worked on?', 'What is his salary?', 'Please pass on a message to him.', 'Thanks, goodbye!', 'Does he have a visa?'];
  for (const q of questions) {
    const a = createSession({ adapter: new MockAdapter([{ text: reply }]), ledger: new Ledger(cfg, { persist: false }), knowledge });
    const b = new W.core.TulipSession({ adapter: new MockAdapter([{ text: reply }]), modelCfg: W.core.MODEL_CFG, knowledge: W.core.KNOWLEDGE, ledger: new W.core.Ledger(W.core.MODEL_CFG, { persist: false }) });
    const ra = await a.ask(q); const rb = await b.ask(q);
    assert.strictEqual(rb.text, ra.text, q);
    assert.strictEqual(rb.meta.path, ra.meta.path, q);
    assert.deepStrictEqual(b.history, a.history, q);
  }
});

test('the model and settings used by the Worker are the project settings, unchanged', () => {
  assert.deepStrictEqual(W.core.MODEL_CFG, loadModelCfg());
  assert.deepStrictEqual(G.CFG.runtime_flags, { message_saving: false, external_delivery: false });
});

test('one request is cheap for the free CPU limit', async () => {
  const hist = [];
  for (let i = 0; i < 6; i++) hist.push({ role: 'user', content: 'What projects has Alex Example worked on and how did the forecasting project work?' }, { role: 'assistant', content: 'Alex Example worked on a forecasting project and a retrieval project.' });
  const run = async () => {
    const s = new W.core.TulipSession({ adapter: new MockAdapter([{ text: 'Alex Example built a forecasting pipeline and a retrieval-augmented generation project.' }]), modelCfg: W.core.MODEL_CFG, knowledge: W.core.KNOWLEDGE, ledger: new W.core.Ledger(W.core.MODEL_CFG, { persist: false }), seedHistory: hist });
    return s.ask('What was their role in the forecasting project?');
  };
  await run();
  const t0 = process.cpuUsage(); for (let i = 0; i < 20; i++) await run(); const t = process.cpuUsage(t0);
  const ms = (t.user + t.system) / 1000 / 20;
  assert.ok(ms < 25, 'CPU per request ' + ms);
});

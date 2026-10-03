'use strict';
// Communication rule: explain what was actually done or used; do not volunteer unused methods, tools or approaches. A general rule in the
// prompt template and the example rules. These offline tests (scripted stand-in model, invented example data) check the instructions and that
// the application adds no keyword logic and does not alter such answers. They cannot show how a live model behaves.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { TulipSession, loadModelCfg } = require('../src/tulip.js');
const { MockAdapter } = require('../src/adapters/mock.js');
const { Ledger } = require('../src/ledger.js');
const { exampleRuntime, ROOT } = require('./helpers/example_runtime.js');

const RULE = 'Explain what was actually done or used. Do not volunteer unused methods, tools or approaches. Mention them only when directly asked, when the visitor requests a comparison, or when necessary to correct a misunderstanding.';
const cfg = loadModelCfg();
const { knowledge } = exampleRuntime();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the rule is in the prompt template and the example rules and reaches the model', () => {
  assert.ok(read('prompts/system_prompt.md').includes(RULE));
  assert.ok(read('examples/knowledge_base/example_knowledge_base.md').includes(RULE));
  assert.strictEqual(knowledge.system.split(RULE).length, 3);
  assert.match(read('prompts/system_prompt.md'), /\(version 1\.5-template\)/);
});

test('the rule is general: it names no topic, tool or project', () => {
  const r = RULE.toLowerCase();
  for (const w of ['rag', 'fine-tun', 'retrieval', 'embedding', 'vector', 'forecast']) assert.ok(!r.includes(w), w);
  const code = ['src/guards.js', 'src/session_core.js', 'src/tulip.js', 'src/knowledge.js', 'worker/app.mjs'].map(read).join('\n');
  assert.ok(!/fine-?tun|vector database|unused method/i.test(code), 'no keyword logic about unused methods');
});

test('an answer about unused methods passes through the application unchanged', async () => {
  const text = 'No. Alex Example did not fine-tune a model and did not use retrieval for that. They compared a seasonal baseline with a gradient-boosted model.';
  const s = new TulipSession({ adapter: new MockAdapter([{ text }]), modelCfg: cfg, knowledge, ledger: new Ledger(cfg, { persist: false }) });
  const r = await s.ask('Did you fine-tune a model, or use RAG?');
  assert.strictEqual(r.text, text);
  assert.ok(!r.meta.retried && r.meta.guards.length === 0);
});

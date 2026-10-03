'use strict';
// Naming rule: an answer names the owner once, then uses pronouns naturally. The application never rewrites names or pronouns in a
// generated answer. Offline tests with a scripted stand-in model and the invented example knowledge base.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../src/guards.js');
const { observe } = require('../src/observations.js');
const { TulipSession, loadModelCfg } = require('../src/tulip.js');
const { MockAdapter } = require('../src/adapters/mock.js');
const { Ledger } = require('../src/ledger.js');
const { exampleRuntime, ROOT } = require('./helpers/example_runtime.js');

const cfg = loadModelCfg();
const { knowledge } = exampleRuntime();
const NAME = new RegExp(G.ownerPattern(G.OWNER), 'g');
const count = (t) => (String(t).replace(G.CFG.public_contact.email, '').match(NAME) || []).length;
const session = (script) => new TulipSession({ adapter: new MockAdapter(script), modelCfg: cfg, knowledge, ledger: new Ledger(cfg, { persist: false }) });
const ask = (text, q = 'Tell me about their work.') => session([{ text }]).ask(q);

test('instructions: the prompt asks for one name per answer and the example rules agree', () => {
  const prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'system_prompt.md'), 'utf8');
  assert.match(prompt, /once per answer/);
  assert.match(prompt, /does not need to name/);
  assert.match(prompt, /unclear/);
  assert.ok(!/Refer to \{\{owner\}\} by name/.test(prompt), 'the old rule is gone');
  assert.ok(knowledge.system.includes('once per answer'));
  assert.ok(knowledge.system.includes('once, at the first reference in that answer'));
  assert.ok(!knowledge.system.includes('{{'));
});

test('there is no automatic pronoun-to-name replacement', () => {
  assert.strictEqual(G.normalisePronouns, undefined);
  for (const f of ['src/guards.js', 'src/session_core.js', 'src/tulip.js']) assert.ok(!/normalisePronouns|pronouns_normalised|refer_to_owner_by_name/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
  assert.ok(!('refer_to_owner_by_name' in (G.CFG.policies || {})));
});

test('multi-sentence answers, possessives and pronoun-only answers pass through unchanged', async () => {
  const cases = [
    'Alex Example built a weekly demand forecast. They compared a seasonal baseline with a gradient-boosted model. Their held-out result favoured the boosted model.',
    "Alex Example's forecasting work covered 40 fictional warehouses. Their role was to design the approach, and the team credits them with the evaluation.",
    'They use Python and SQL. Their daily stack also includes scikit-learn.',
  ];
  for (const text of cases) { const r = await ask(text); assert.strictEqual(r.text, text); assert.ok(count(r.text) <= 1); }
});

test('a repeated name written by the model is not rewritten, and no extra model call is made', async () => {
  const text = 'Alex Example built the pipeline. Alex Example then evaluated it.';
  const adapter = new MockAdapter([{ text }]);
  const s = new TulipSession({ adapter, modelCfg: cfg, knowledge, ledger: new Ledger(cfg, { persist: false }) });
  const r = await s.ask('What did they build?');
  assert.strictEqual(r.text, text);
  assert.strictEqual(adapter.calls.length, 1);
  assert.ok(observe(r.text, { question: 'x', facts: knowledge.facts }).some((o) => o.kind === 'name_frequency'));
  assert.ok(!observe('Alex Example built it. They evaluated it.', { question: 'x', facts: knowledge.facts }).some((o) => o.kind === 'name_frequency' || o.kind === 'pronoun'));
});

test('fixed texts name the owner at most once', () => {
  for (const [k, v] of Object.entries(G.FIXED)) assert.ok(count(v) <= 1, k + ': ' + v);
});

test('unknown-information: the appended contact sentence avoids repeating the name', () => {
  const email = G.CFG.public_contact.email;
  const named = G.fixInquiryOffers('Alex Example used Python in that project. Would you like to leave a message?', { message_saving: false });
  assert.strictEqual(named.text, 'Alex Example used Python in that project. ' + G.FIXED.authored_contact_no_messaging_named);
  assert.strictEqual(count(named.text), 1); assert.ok(named.text.includes(email));
  const plain = G.fixInquiryOffers('Currently, I don’t have information on that. Would you like to leave a message?', { message_saving: false });
  assert.strictEqual(count(plain.text), 1);
  assert.strictEqual(G.contactTail({ message_saving: false }, 'They used Python.'), G.FIXED.authored_contact_no_messaging);
  assert.strictEqual(G.contactTail({ message_saving: true }, 'Alex Example used Python.'), G.FIXED.authored_contact_with_messaging_named);
});

test('the object pronoun comes from configuration', () => {
  const real = G.CFG.fixed_text.authored_contact_no_messaging_named;
  assert.ok(real.includes(' ' + (require('../config/guards.json').identity.object_pronoun || 'them') + ' '));
});

test('ownership, financial refusal and greeting texts name the owner once', async () => {
  for (const k of ['authored_authorship_answer', 'authored_authorship_brand', 'financial_refusal', 'welcome', 'authored_farewell']) assert.strictEqual(count(G.FIXED[k]), 1, k);
  const s = session([]);
  const fin = await s.ask('What is their salary?');
  assert.strictEqual(fin.text, G.FIXED.financial_refusal);
  const msg = await session([]).ask('Please pass a message to them that we want to hire them.');
  assert.strictEqual(msg.text, G.FIXED.authored_message_request_no_messaging);
  const intro = await ask('Thank you for introducing yourself. How can I help you today?', 'Hi, I am a recruiter at Acme.');
  assert.strictEqual(count(intro.text), 0);
});

test('a repeated welcome is removed without editing the rest of the answer', () => {
  const out = G.applyOutputGuards(G.FIXED.welcome + ' They have an M.Sc. in Data Science.', {});
  assert.strictEqual(out.text, 'They have an M.Sc. in Data Science.');
});

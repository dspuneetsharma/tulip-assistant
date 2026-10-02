'use strict';
// Budget-capped evaluation runner. A person reads every answer; the automatic checks only flag clear failures (see scripts/eval_checks.js).
// Usage:
//   node scripts/run_eval.js                       -> the example review set (examples/evaluation/example_cases.json), live model
//   node scripts/run_eval.js --cases B1,P1,X2      -> chosen cases from the set
//   node scripts/run_eval.js --set other.json      -> a case file from evaluations/ (your private sets, git-ignored) or examples/evaluation/
//   node scripts/run_eval.js --mock                -> structural run with a scripted stand-in (NOT a model, no network)
// Options: --budget N (estimated Neurons, default 2400)  --max-calls N (default 40)
//          --dashboard-before N --dashboard-after N (Neurons read from the Cloudflare dashboard, optional)
const fs = require('fs');
const path = require('path');
const G = require('../src/guards.js');
const { createSession, loadModelCfg, BudgetError } = require('../src/tulip.js');
const { MockAdapter } = require('../src/adapters/mock.js');
const { CloudflareAdapter, loadChoices } = require('../src/adapters/cloudflare.js');
const { Ledger } = require('../src/ledger.js');
const { loadRuntime } = require('../src/knowledge.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const mock = flag('mock');
const budget = Number(opt('budget', 2400));
const maxCalls = Number(opt('max-calls', 40));
const cfg = loadModelCfg();
const knowledge = loadRuntime(G.CFG.runtime_flags);

function loadCases() {
  const file = path.basename(opt('set', 'example_cases.json')); // a file name inside evaluations/ or examples/evaluation/ only
  const priv = path.join(ROOT, 'evaluations', file);
  const d = JSON.parse(fs.readFileSync(fs.existsSync(priv) ? priv : path.join(ROOT, 'examples', 'evaluation', file), 'utf8'));
  const ids = opt('cases', null);
  let cases = d.cases;
  if (ids) { const want = ids.split(',').map((x) => x.trim()); cases = want.map((id) => { const c = d.cases.find((x) => x.id === id); if (!c) throw new Error('Unknown case ' + id); return c; }); }
  return { set: file + ' (' + d.version + ')' + (ids ? ' [' + ids + ']' : ''), cases };
}

const { autoChecks } = require('./eval_checks.js');

(async () => {
  const { set, cases } = loadCases();
  const choices = loadChoices();
  const adapter = mock
    ? new MockAdapter([() => ({ text: 'Mock answer for structural testing only.' })])
    : new CloudflareAdapter(cfg);
  if (!mock) {
    if (!adapter.hasCredentials()) { console.log('Credentials not set in this terminal. See docs/setup.md.'); process.exit(2); }
    if (!choices.access_verified) { console.log('Run "node scripts/check_access.js" first.'); process.exit(2); }
  }
  const ledger = new Ledger(cfg, { persist: !mock });
  const startedAt = new Date().toISOString();
  const runId = (mock ? 'mock-' : 'live-') + startedAt.replace(/[-:]/g, '').slice(0, 15);
  const expectedCalls = cases.reduce((n, c) => n + c.turns.length, 0);
  console.log((mock ? '[MOCK RUN: no model is used; results are structural only]\n' : '') + 'Set:', set, '| cases:', cases.length, '| turns:', expectedCalls, '| estimated-Neuron budget:', budget, '| max model calls:', maxCalls);
  console.log('Variant:', adapter.variant, '| endpoint:', adapter.endpointStyle || 'n/a', '| model:', cfg.model, '\n');

  const results = []; let calls = 0; let stopped = null;
  outer: for (const c of cases) {
    let session;
    try { session = createSession({ adapter, modelCfg: cfg, knowledge, ledger, runBudget: budget, seedHistory: c.seed || null }); }
    catch (e) { results.push({ id: c.id, category: c.category, error: e.message }); continue; }
    const turnResults = [];
    for (const turn of c.turns) {
      if (calls >= maxCalls) { stopped = 'max-calls reached'; break outer; }
      let res;
      try { res = await session.ask(turn.user); }
      catch (e) { if (e instanceof BudgetError) { stopped = e.message; break outer; } throw e; }
      calls += res.meta.calls.length;
      const checks = autoChecks(turn, res.text, res.meta);
      const failed = checks.filter((k) => !k.pass);
      const crit = failed.filter((k) => k.severity === 'critical'); const rev = failed.filter((k) => k.severity === 'review'); const adv = failed.filter((k) => k.severity === 'advisory');
      turnResults.push({ user: turn.user, answer: res.text, path: res.meta.path, status: res.meta.status, latencyMs: res.meta.latencyMs, usage: res.meta.usage, est_neurons: res.meta.est_neurons, guards: res.meta.guards, retried: res.meta.retried, first_draft: res.meta.first_draft || null, look_for: turn.look_for || null, calls: res.meta.calls.map((k) => ({ status: k.status, finish: k.finish, variant: k.variant, latencyMs: k.latencyMs, reasoning: k.reasoning })), critical: crit.map((k) => k.name), review: rev.map((k) => k.name), advisory: adv.map((k) => k.name) });
      console.log((crit.length ? 'CRITICAL   ' : rev.length ? 'review     ' : 'ok         ') + c.id + ' [' + res.meta.path + ', ' + res.meta.latencyMs + ' ms, ' + res.meta.usage.prompt_tokens + '/' + res.meta.usage.completion_tokens + ' tok] ' + (crit.length ? '-> ' + crit.map((k) => k.name).join('; ') : rev.length ? '-> look at: ' + rev.map((k) => k.name).join('; ') : ''));
    }
    results.push({ id: c.id, category: c.category, seeded: !!(c.seed && c.seed.length), turns: turnResults });
  }

  const all = results.flatMap((r) => r.turns || []);
  const modelTurns = all.filter((t) => t.path === 'model');
  const lat = modelTurns.map((t) => t.latencyMs).sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
  const sum = (f) => all.reduce((n, t) => n + f(t), 0);
  const before = opt('dashboard-before', null); const after = opt('dashboard-after', null);
  const summary = {
    run_id: runId, kind: mock ? 'MOCK (structural only, not a model)' : 'LIVE model', started_at: startedAt,
    model: cfg.model, endpoint_style: adapter.endpointStyle || null, reasoning_variant: adapter.variant, prompt_version: knowledge.info.prompt_version,
    knowledge_base_version: knowledge.info.knowledge_base_version, knowledge_base_sha256: knowledge.info.source_sha256,
    case_set: set, turns_run: all.length, model_turns: modelTurns.length, guard_turns: all.length - modelTurns.length, model_http_calls: calls,
    stopped_early: stopped,
    critical_failures: all.filter((t) => t.critical.length).length,
    turns_with_review_flags: all.filter((t) => t.review.length).length,
    turns_with_advisory_notes: all.filter((t) => t.advisory.length).length,
    latency_ms: { model_turns_p50: pct(0.5), model_turns_p90: pct(0.9), max: lat.length ? lat[lat.length - 1] : null, mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null },
    tokens_reported: { input: sum((t) => t.usage.prompt_tokens), output: sum((t) => t.usage.completion_tokens), all_reported_by_api: all.every((t) => t.usage.reported) },
    neurons: {
      ESTIMATE_from_reported_tokens: Number(sum((t) => t.est_neurons).toFixed(1)),
      estimate_basis: 'reported tokens x published per-million Neuron rates (config/model.json); NOT a measurement',
      dashboard_before: before != null ? Number(before) : 'not recorded',
      dashboard_after: after != null ? Number(after) : 'not recorded',
      DASHBOARD_MEASURED_delta: before != null && after != null ? Number(after) - Number(before) : 'not recorded',
    },
  };
  // mock (offline test) runs are kept apart so the live results folder holds only live runs
  const outDir = path.join(ROOT, 'evaluations', 'results', mock ? 'mock' : '');
  const outRel = 'evaluations/results/' + (mock ? 'mock/' : '');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, runId + '.json'), JSON.stringify({ summary, results }, null, 2));

  // Human-review transcript
  let md = '# Evaluation run ' + runId + '\n\n**' + summary.kind + '**. Automatic checks only flag clear failures; style notes are advisory. Review every answer yourself.\n\n```json\n' + JSON.stringify(summary, null, 2) + '\n```\n\n';
  for (const r of results) {
    md += '## ' + r.id + ' (' + r.category + ')\n\n';
    if (r.error) { md += 'Error: ' + r.error + '\n\n'; continue; }
    for (const t of r.turns) {
      md += '- **Visitor:** ' + t.user + '\n- **Tulip:** ' + t.answer + '\n- _path ' + t.path + ', ' + t.latencyMs + ' ms, tokens ' + t.usage.prompt_tokens + '/' + t.usage.completion_tokens + ', guards: ' + (t.guards.join(', ') || 'none') + '_\n';
      if (t.look_for) md += '- Read for: ' + t.look_for.join('; ') + '\n';
      md += '- Automatic: ' + (t.critical.length ? 'CRITICAL [' + t.critical.join('; ') + '] ' : 'no clear failure. ') + (t.review.length ? 'Look at [' + t.review.join('; ') + '] ' : '') + (t.advisory.length ? 'Style notes (advisory) [' + t.advisory.join('; ') + ']' : '') + '\n\n';
    }
  }
  fs.writeFileSync(path.join(outDir, runId + '.md'), md);

  console.log('\nSUMMARY');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nFull transcript for review: ' + outRel + runId + '.md');
  if (!mock && before == null) console.log('Reminder: the Cloudflare dashboard (Workers AI usage) is the authoritative figure; the Neuron numbers above are estimates.');
})().catch((e) => { console.error('Run aborted:', e.message); process.exit(1); });

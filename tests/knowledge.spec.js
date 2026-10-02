'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { build, sha } = require('../scripts/build_runtime.js');
const { loadRuntime } = require('../src/knowledge.js');
const G = require('../src/guards.js');
const { tmp, EXAMPLE } = require('./helpers/example_runtime.js');

test('build_runtime splits the example knowledge base losslessly into rules and facts', () => {
  const out = tmp('kb-');
  const { manifest, rules, facts } = build({ source: EXAMPLE, outDir: out });
  const src = fs.readFileSync(EXAMPLE, 'utf8');
  const i3 = src.indexOf('\n## 3. ') + 1; const i12 = src.indexOf('\n## 12. ') + 1;
  assert.strictEqual(rules + '', src.slice(0, i3) + src.slice(i12)); assert.strictEqual(facts, src.slice(i3, i12));
  assert.ok(rules.includes('## 2.') && rules.includes('## 12.') && rules.includes('## 13.'));
  assert.ok(facts.includes('## 3.') && facts.includes('## 11.') && !facts.includes('## 12.'));
  assert.strictEqual(manifest.knowledge_base_version, '1.0'); assert.strictEqual(manifest.lossless, true);
  assert.strictEqual(manifest.files['knowledge_base/runtime/facts.md'].sha256, sha(facts));
  assert.deepStrictEqual(manifest.audit_findings, []);
});

test('build_runtime reports a clear error for a missing file or missing headings', () => {
  assert.throws(() => build({ source: path.join(tmp('x-'), 'nope.md'), outDir: tmp('o-') }), /Knowledge base not found/);
  const bad = path.join(tmp('x-'), 'bad.md'); fs.writeFileSync(bad, '# Title\n\n## 1. Rules\n\ntext\n');
  assert.throws(() => build({ source: bad, outDir: tmp('o-') }), /Heading "## 3\."/);
});

test('build_runtime audit flags pay figures and configured withheld terms in the answering context', () => {
  const src = path.join(tmp('x-'), 'kb.md');
  fs.writeFileSync(src, '# T\n\nVersion: 2.0\n\n## 1. Use\n\n## 2. Rules\n\n## 3. Profile\n\nThe salary was 20 LPA. Read the Zebrafish handbook.\n\n## 12. Unprovided\n\n## 13. Patterns\n');
  const old = G.CFG.blocked_terms; G.CFG.blocked_terms = ['zebrafish'];
  try {
    const { manifest } = build({ source: src, outDir: tmp('o-') });
    const checks = manifest.audit_findings.map((f) => f.check);
    assert.ok(checks.includes('financial figure') && checks.includes('withheld term (config blocked_terms)'));
    assert.strictEqual(manifest.knowledge_base_version, '2.0');
  } finally { G.CFG.blocked_terms = old; }
});

test('loader: verifies hashes, so an edited runtime file is refused', () => {
  const dir = tmp('rt-'); build({ source: EXAMPLE, outDir: dir });
  assert.ok(loadRuntime(G.CFG.runtime_flags, { runtimeDir: dir }).system.length > 1000);
  fs.appendFileSync(path.join(dir, 'facts.md'), '\n- An unreviewed extra fact.\n');
  assert.throws(() => loadRuntime(G.CFG.runtime_flags, { runtimeDir: dir }), /hash mismatch/);
});

test('loader: line endings do not matter for the hash', () => {
  const dir = tmp('rt-'); build({ source: EXAMPLE, outDir: dir });
  const f = path.join(dir, 'rules.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  assert.ok(loadRuntime(G.CFG.runtime_flags, { runtimeDir: dir }).system.includes('RULES'));
});

test('loader: a missing private knowledge base gives instructions, not a stack trace', () => {
  assert.throws(() => loadRuntime(G.CFG.runtime_flags, { runtimeDir: path.join(tmp('empty-'), 'runtime') }), /Missing runtime manifest/);
  const dir = tmp('rt-'); build({ source: EXAMPLE, outDir: dir }); fs.rmSync(path.join(dir, 'facts.md'));
  assert.throws(() => loadRuntime(G.CFG.runtime_flags, { runtimeDir: dir }), /docs\/knowledge-base\.md/);
});

test('loader: reads only allowlisted files', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'runtime_files.json'), 'utf8'));
  assert.deepStrictEqual(cfg.allowed, ['prompts/system_prompt.md', 'knowledge_base/runtime/rules.md', 'knowledge_base/runtime/facts.md']);
});

test('prompt template: only known placeholders, version header present', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system_prompt.md'), 'utf8');
  const found = new Set((t.match(/\{\{[^}]*\}\}/g) || []));
  assert.deepStrictEqual([...found].sort(), ['{{assistant}}', '{{owner}}']);
  assert.match(t, /\(version [0-9.]+/);
  assert.match(t, /\[OFF_TOPIC\]/);
});

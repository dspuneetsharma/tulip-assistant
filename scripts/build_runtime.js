'use strict';
// Builds the runtime knowledge files from YOUR private knowledge base (a Markdown file with numbered "## N." sections).
//   RULES = everything before "## 3." plus everything from "## 12." onward (identity, behaviour, boundaries, answer patterns)
//   FACTS = sections 3 to 11 (the facts about the person)
// The split is lossless: segments are exact substrings of the source; nothing is reworded.
//
// Usage:  node scripts/build_runtime.js                      (source: knowledge_base/knowledge_base.md, output: knowledge_base/runtime/)
//         node scripts/build_runtime.js --example            (source: examples/knowledge_base/example_knowledge_base.md, invented data)
//         node scripts/build_runtime.js --source my.md --out some/dir
// The output folder is git-ignored. Never commit it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(String(s).replace(/\r\n/g, '\n'), 'utf8').digest('hex'); // line-ending neutral

function build({ source, outDir }) {
  if (!fs.existsSync(source)) throw new Error('Knowledge base not found: ' + source + '. See docs/knowledge-base.md (or use --example).');
  const src = fs.readFileSync(source, 'utf8');
  const idx = (re, label) => { const m = re.exec(src); if (!m) throw new Error('Heading "## ' + label + '" not found in ' + path.basename(source) + '. See docs/knowledge-base.md for the expected structure.'); return m.index; };
  const i3 = idx(/^## 3\. /m, '3.');
  const i12 = idx(/^## 12\. /m, '12.');
  if (i12 <= i3) throw new Error('Section 12 must come after section 3.');
  const segA = src.slice(0, i3); const segB = src.slice(i3, i12); const segC = src.slice(i12);
  const rules = segA + segC; const facts = segB;
  if (segA + segB + segC !== src) throw new Error('Split is not lossless');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'rules.md'), rules, 'utf8');
  fs.writeFileSync(path.join(outDir, 'facts.md'), facts, 'utf8');

  // Audit: things that should not be in the answering context.
  const G = require('../src/guards.js');
  const checks = [
    ['financial figure', /(₹|\brs\.?\s?\d|\binr\b|\busd\b|\$\s?\d|\blpa\b|\blakhs?\b|\bcrore\b)/i],
    ['pay term near a number', /(ctc|salary|compensation|stipend|package)[^.\n]{0,40}\d/i],
    ['administrative note marker', /admin[_ ]notes|source_reports/i],
  ];
  const blocked = (G.CFG.blocked_terms || []).filter(Boolean);
  if (blocked.length) checks.push(['withheld term (config blocked_terms)', new RegExp(blocked.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')]);
  const audit = [];
  for (const [name, re] of checks) {
    for (const [label, text] of [['rules', rules], ['facts', facts]]) {
      const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      if (m) audit.push({ file: label, check: name, matches: [...new Set(m)].slice(0, 5) });
    }
  }
  const manifest = {
    built_at: new Date().toISOString(),
    source: path.basename(source),
    source_sha256: sha(src),
    source_bytes: Buffer.byteLength(src, 'utf8'),
    knowledge_base_version: (src.match(/Version:\s*([0-9.]+)/) || [])[1] || 'unknown',
    lossless: true,
    files: {
      'knowledge_base/runtime/rules.md': { sha256: sha(rules), bytes: Buffer.byteLength(rules, 'utf8'), contents: 'header + sections 1, 2, 12 onward (verbatim)' },
      'knowledge_base/runtime/facts.md': { sha256: sha(facts), bytes: Buffer.byteLength(facts, 'utf8'), contents: 'sections 3-11 (verbatim)' },
    },
    audit_findings: audit,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifest, rules, facts };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
  const source = argv.includes('--example')
    ? path.join(ROOT, 'examples', 'knowledge_base', 'example_knowledge_base.md')
    : path.resolve(opt('source') || path.join(ROOT, 'knowledge_base', 'knowledge_base.md'));
  const outDir = path.resolve(opt('out') || path.join(ROOT, 'knowledge_base', 'runtime'));
  try {
    const { manifest, rules, facts } = build({ source, outDir });
    console.log('Split OK (lossless). rules: %d chars, facts: %d chars -> %s', rules.length, facts.length, path.relative(ROOT, outDir) || '.');
    if (manifest.audit_findings.length) { console.log('AUDIT FINDINGS (review these):'); console.log(JSON.stringify(manifest.audit_findings, null, 2)); }
    else console.log('Audit: no financial figures, withheld terms or administrative markers found in the runtime files.');
  } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { build, sha };

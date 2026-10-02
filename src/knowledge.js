'use strict';
// Loads ONLY the explicitly allowlisted runtime files and verifies the knowledge files against the build manifest.
// The knowledge itself (rules + facts) is YOUR private material: it is built by scripts/build_runtime.js into knowledge_base/runtime/,
// which is git-ignored. See docs/knowledge-base.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./guards.js');

const ROOT = path.resolve(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(String(s).replace(/\r\n/g, '\n'), 'utf8').digest('hex'); // line-ending neutral

// opts.runtimeDir: where rules.md, facts.md and manifest.json live (default: knowledge_base/runtime). Used by the tests.
function loadRuntime(flags, opts = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtime_files.json'), 'utf8'));
  const allowed = cfg.allowed.map((p) => path.normalize(p));
  const runtimeDir = path.resolve(opts.runtimeDir || path.join(ROOT, 'knowledge_base', 'runtime'));

  const locate = (rel) => {
    const norm = path.normalize(rel);
    if (!allowed.includes(norm)) throw new Error('Refusing to load a file that is not on the runtime allowlist: ' + rel);
    const abs = norm.startsWith('knowledge_base') ? path.join(runtimeDir, path.basename(norm)) : path.resolve(ROOT, norm);
    const base = norm.startsWith('knowledge_base') ? runtimeDir : ROOT;
    if (!abs.startsWith(base + path.sep)) throw new Error('Path escapes its folder: ' + rel);
    return abs;
  };
  const read = (rel) => {
    const abs = locate(rel);
    if (!fs.existsSync(abs)) {
      throw new Error('Missing ' + rel + '. Your private knowledge base has not been built yet. Create knowledge_base/knowledge_base.md ' +
        '(see docs/knowledge-base.md) and run "npm run build:runtime", or try the bundled example with "npm run demo:build".');
    }
    return fs.readFileSync(abs, 'utf8');
  };
  const manifestPath = path.join(runtimeDir, path.basename(cfg.manifest));
  if (!fs.existsSync(manifestPath)) throw new Error('Missing runtime manifest. Run "npm run build:runtime" (or "npm run demo:build" for the example).');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const systemPrompt = G.fillText(read('prompts/system_prompt.md'));
  const rules = read('knowledge_base/runtime/rules.md');
  const facts = read('knowledge_base/runtime/facts.md');

  // Integrity: runtime knowledge must match what build_runtime.js produced from your source file.
  for (const [rel, text] of [['knowledge_base/runtime/rules.md', rules], ['knowledge_base/runtime/facts.md', facts]]) {
    const want = manifest.files[rel] && manifest.files[rel].sha256;
    if (want !== sha(text)) throw new Error('Runtime file changed since build (hash mismatch): ' + rel + '. Re-run: npm run build:runtime');
  }

  // What the model needs to follow the contact policy: the current mode and the exact sentences for it (from config/guards.json).
  const fx = G.FIXED;
  const saving = !!flags.message_saving;
  const flagLine =
    'RUNTIME FLAGS: message_saving=' + saving + '; external_delivery=' + !!flags.external_delivery + '.' +
    '\nEXAMPLE WORDING FOR A CLEAR QUESTION WHOSE DETAIL IS NOT RECORDED (adapt it naturally; not a fixed template; never use it for an unclear question): ' + (saving ? fx.unknown_detail + ' ' + fx.authored_contact_with_messaging : fx.unknown_detail_no_messaging) +
    '\nEXAMPLE WORDING FOR A FINANCE-RELATED DETAIL THAT IS NOT RECORDED (not a direct pay or savings question): ' + fx.unknown_finance_detail +
    '\nCONTACT SENTENCE (the next step for a missing detail): ' + (saving ? fx.authored_contact_with_messaging : fx.authored_contact_no_messaging);
  const promptVersion = (systemPrompt.match(/\(version\s*([0-9.]+)/i) || [])[1] || 'unknown';

  // Static content first (prefix-stable, so provider-side prompt caching can help if available).
  const system =
    systemPrompt.trim() +
    '\n\n=== RULES (approved behaviour rules) ===\n' + rules.trim() +
    '\n\n=== FACTS (approved facts about ' + G.OWNER + ') ===\n' + facts.trim() +
    '\n\n=== ' + flagLine + ' ===\n';

  return {
    system,
    facts,
    info: {
      prompt_version: promptVersion,
      knowledge_base_version: manifest.knowledge_base_version,
      source_sha256: manifest.source_sha256,
      files_loaded: cfg.allowed,
      system_chars: system.length,
      estimated_tokens_heuristic: Math.round(system.length / 4), // heuristic only; real count comes from reported usage
    },
  };
}

module.exports = { loadRuntime };

'use strict';
// Scans files for private-looking data before they are committed or published.
//   node scripts/check_private_data.js                    scan all tracked files (or, outside a repo, every file not git-ignored by name)
//   node scripts/check_private_data.js --staged           scan only what is staged (used by .githooks/pre-commit)
//   node scripts/check_private_data.js --denylist FILE    also flag every line of FILE (one case-insensitive regex per line):
//                                                         your own name, employer, phone number and so on. Keep that file OUT of the repo
//                                                         (.private-denylist.txt is git-ignored).
// Exit code 1 when anything is found. Matches are reported as file:line and rule name; the matched text is not printed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };

const SAFE_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'users.noreply.github.com']);
const RULES = [
  { name: 'email address outside example domains', re: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, test: (m) => !SAFE_EMAIL_DOMAINS.has(m[1].toLowerCase()) },
  { name: 'phone number', re: /(?<![\w.])\+\d{1,3}[\s-]?\d[\d\s-]{7,}\d/g },
  { name: '32-character hex id (for example a Cloudflare account id)', re: /\b[a-f0-9]{32}\b/gi },
  { name: 'workers.dev address with a real subdomain', re: /\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/gi },
  { name: 'API token or secret assignment', re: /\b(?:api[_-]?token|secret|password|passwd|bearer)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{16,}["']/gi },
  { name: 'token-like prefix', re: /\b(?:cfat_|cfut_|ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{16,})[A-Za-z0-9_]{8,}/g },
  { name: 'Windows user path', re: /[A-Za-z]:\\Users\\[^\s"']+/g },
];
const FORBIDDEN_PATHS = [/^knowledge_base\//, /^worker\/generated\//, /^public\//, /^logs\//, /^evaluations\//, /^reports\//, /^checkpoints\//, /^\.env(?!\.example$)(\.|$)/, /^config\/local_choices\.json$/, /(^|\/)\.dev\.vars/, /\.(pem|key)$/];
// Narrow exception: one public demo address that the repository owner has explicitly authorised for publication, permitted in README.md only.
// It is listed by SHA-256 so this script (and the denylist scan) does not itself contain the address. Any other address, or the same address
// in any other file, is still reported.
const ALLOWED_PUBLIC_URLS = { 'README.md': new Set(['ccd5230b1ad01fb60589e1edd80c4d7bd8a006f331d64c203fc03da9132339af']) };
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function maskAllowed(rel, text) {
  const allowed = ALLOWED_PUBLIC_URLS[rel];
  if (!allowed) return text;
  return text.replace(/https?:\/\/[^\s)\]>"'<]+/g, (tok) => (allowed.has(sha256(tok.replace(/[.,;:!?]+$/, ''))) ? '[allowed-public-demo-url]' : tok));
}
const SKIP_EXT = /\.(png|jpg|jpeg|gif|ico|woff2?|zip|pdf)$/i;

function listFiles() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  try {
    if (argv.includes('--staged')) return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    return git(['ls-files']);
  } catch (_) {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git'].includes(e.name)) continue; const f = path.join(d, e.name); e.isDirectory() ? walk(f) : out.push(path.relative(ROOT, f).split(path.sep).join('/')); } };
    walk(ROOT); return out;
  }
}

function scan(files, denyRes) {
  const findings = [];
  for (const rel of files) {
    if (FORBIDDEN_PATHS.some((re) => re.test(rel))) { findings.push({ file: rel, line: 0, rule: 'path must never be committed' }); continue; }
    if (SKIP_EXT.test(rel)) continue;
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((rawText, i) => {
      const text = maskAllowed(rel, rawText);
      for (const r of RULES) {
        r.re.lastIndex = 0; let m;
        while ((m = r.re.exec(text))) { if (!r.test || r.test(m)) { findings.push({ file: rel, line: i + 1, rule: r.name }); break; } }
      }
      for (const d of denyRes) if (d.re.test(text)) findings.push({ file: rel, line: i + 1, rule: 'denylist entry #' + d.n });
    });
  }
  return findings;
}

function loadDeny(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l, i) => ({ n: i + 1, re: new RegExp(l, 'i') }));
}

if (require.main === module) {
  const deny = loadDeny(opt('denylist') || path.join(ROOT, '.private-denylist.txt'));
  const files = listFiles();
  const findings = scan(files, deny);
  if (findings.length) {
    console.error('Possible private data (' + findings.length + '):');
    for (const f of findings.slice(0, 200)) console.error('  ' + f.file + (f.line ? ':' + f.line : '') + '  ' + f.rule);
    console.error('\nCommit blocked. Fix the lines above, or keep the file out of the repository.');
    process.exit(1);
  }
  console.log('check:private OK (' + files.length + ' files scanned' + (deny.length ? ', ' + deny.length + ' denylist entries' : '') + ')');
}
module.exports = { scan, RULES, FORBIDDEN_PATHS, loadDeny, maskAllowed, ALLOWED_PUBLIC_URLS };

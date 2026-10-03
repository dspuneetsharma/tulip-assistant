'use strict';
// The repository must stay free of private-looking data, and the scanner must actually catch it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scan, RULES, FORBIDDEN_PATHS, loadDeny, maskAllowed, ALLOWED_PUBLIC_URLS } = require('../scripts/check_private_data.js');
const { tmp, ROOT } = require('./helpers/example_runtime.js');

const ANY_LEVEL = new Set(['node_modules', '.git', '.wrangler']);
const TOP_LEVEL = new Set(['knowledge_base', 'public', 'logs', 'evaluations', 'reports', 'checkpoints', 'experiments', 'export', '_to_delete', 'messages']); // git-ignored; worker/generated handled below
function sourceFiles(dir = ROOT, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) return (ANY_LEVEL.has(e.name) || (!rel && TOP_LEVEL.has(e.name)) || r === 'worker/generated') ? [] : sourceFiles(path.join(dir, e.name), r);
    return /^(\.env(\.|$)(?!example)|\.dev\.vars)/.test(e.name) ? [] : [r];
  });
}

test('the scanner finds nothing in the repository source files', () => {
  const files = sourceFiles();
  assert.ok(files.length > 30);
  assert.ok(files.includes('examples/knowledge_base/example_knowledge_base.md'), 'the example knowledge base is scanned');
  assert.deepStrictEqual(scan(files, []), []);
});

test('the scanner detects planted samples of every kind', () => {
  // Built from fragments so this file itself contains no matching literal.
  const samples = {
    'email address outside example domains': 'contact: jane.doe' + '@' + 'mail-provider.test2.io',
    'phone number': 'call +' + '44 20 7946 0958',
    '32-character hex id': 'account ' + 'a'.repeat(16) + 'b1'.repeat(8),
    'workers.dev address': 'https://tulip.' + 'someone' + '.workers.dev/',
    'API token or secret assignment': 'api_token = "' + 'x'.repeat(24) + '"',
    'token-like prefix': 'ghp_' + 'A1b2C3d4E5f6G7h8',
    'Windows user path': 'C:' + '\\Users\\someone\\project',
  };
  const dir = tmp('assistant-priv-');
  for (const [name, text] of Object.entries(samples)) {
    fs.writeFileSync(path.join(dir, 'f.txt'), text + '\n');
    const rel = path.relative(ROOT, path.join(dir, 'f.txt')).split(path.sep).join('/');
    const found = scan([rel], []);
    assert.ok(found.length >= 1, 'not detected: ' + name);
  }
});

test('example domains and generic placeholders are allowed', () => {
  const dir = tmp('assistant-priv-ok-');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'owner@example.com and name@users.noreply.github.com and YOUR_ACCOUNT_ID\n');
  assert.deepStrictEqual(scan([path.relative(ROOT, path.join(dir, 'ok.txt')).split(path.sep).join('/')], []), []);
});

test('forbidden paths are reported even when empty', () => {
  const bad = ['knowledge_base/runtime/facts.md', 'worker/generated/tulip_core.mjs', 'public/index.html', '.env', '.dev.vars', 'config/local_choices.json', 'logs/x.json', 'reports/a.md', 'key.pem'];
  for (const b of bad) assert.ok(FORBIDDEN_PATHS.some((re) => re.test(b)), b);
  assert.ok(!FORBIDDEN_PATHS.some((re) => re.test('.env.example')));
  assert.ok(!FORBIDDEN_PATHS.some((re) => re.test('examples/knowledge_base/example_knowledge_base.md')));
});

test('a denylist flags personal terms without printing them', () => {
  const dir = tmp('assistant-priv-deny-');
  fs.writeFileSync(path.join(dir, 'deny.txt'), '# comment\nsecret-employer-name\n');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'I work at Secret-Employer-Name.\n');
  const deny = loadDeny(path.join(dir, 'deny.txt'));
  const found = scan([path.relative(ROOT, path.join(dir, 'f.txt')).split(path.sep).join('/')], deny);
  assert.strictEqual(found.length, 1);
  assert.ok(!JSON.stringify(found).toLowerCase().includes('secret-employer'));
});

test('.gitignore keeps private material out of the repository', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const needed of ['/knowledge_base/', '/worker/generated/', '/public/', '/evaluations/', '/logs/', '/reports/', '/checkpoints/', '.env', '.env.*', '.dev.vars', '.private-denylist.txt', 'config/local_choices.json', '*.pem', '*.key']) assert.ok(gi.includes(needed), 'missing rule ' + needed);
  assert.ok(gi.includes('!.env.example'));
  assert.ok(RULES.length >= 7);
});

test('the pre-commit hook runs the scanner on staged files', () => {
  const hook = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8');
  assert.match(hook, /check_private_data\.js --staged/);
});

test('the one authorised demo address is allowed in README.md only; other workers.dev addresses are still flagged', () => {
  const demo = 'https://tulip.' + ['ds-pu', 'neets', 'harma'].join('') + '.workers.dev';       // assembled so this file does not contain the address
  assert.deepStrictEqual(Object.keys(ALLOWED_PUBLIC_URLS), ['README.md']);
  assert.strictEqual(ALLOWED_PUBLIC_URLS['README.md'].size, 1);
  assert.ok(!maskAllowed('README.md', 'See [demo](' + demo + ').').includes('workers.dev'), 'allowed in README.md, with markdown punctuation');
  assert.ok(maskAllowed('docs/setup.md', demo).includes('workers.dev'), 'not allowed in another file');
  assert.ok(maskAllowed('README.md', demo + '/extra-path').includes('workers.dev'), 'only the exact address');
  assert.ok(maskAllowed('README.md', 'https://tulip.' + 'someone-else' + '.workers.dev').includes('workers.dev'));
  assert.ok(maskAllowed('README.md', 'http://tulip.' + ['ds-pu', 'neets', 'harma'].join('') + '.workers.dev').includes('workers.dev'), 'scheme must match');
});

test('README links to the live demo with the agreed link text', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\[Try the live Tulip assistant\]\(https:\/\/tulip\.[a-z0-9-]+\.workers\.dev\)/);
  assert.deepStrictEqual(scan(['README.md'], []), []);
});

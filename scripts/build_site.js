'use strict';
// Renders the website templates in site/ into public/ (git-ignored), filling {{assistant}}, {{owner}}, {{email}} and {{welcome}}
// from config/guards.json. The result contains no knowledge, only the configured name, contact email and welcome text.
// Usage: node scripts/build_site.js [--out dir]
const fs = require('fs');
const path = require('path');
const G = require('../src/guards.js');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const VALUES = () => ({ assistant: G.ASSISTANT, owner: G.OWNER, email: G.CFG.public_contact.email, welcome: G.FIXED.welcome });
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escJs = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, '\\u003c').replace(/\n/g, '\\n');
const esc = { '.html': escHtml, '.svg': escHtml, '.js': escJs };

function renderSite(outDir) {
  const v = VALUES();
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const name of fs.readdirSync(SITE)) {
    const full = path.join(SITE, name);
    if (!fs.statSync(full).isFile()) continue;
    const e = esc[path.extname(name)] || ((s) => s);
    let text = fs.readFileSync(full, 'utf8').replace(/\{\{(assistant|owner|email|welcome)\}\}/g, (_m, k) => e(v[k]));
    fs.writeFileSync(path.join(outDir, name), text);
    written.push(name);
  }
  return written;
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(ROOT, 'public'));
  const files = renderSite(out);
  console.log('wrote ' + files.length + ' site files to ' + path.relative(ROOT, out));
}
module.exports = { renderSite };

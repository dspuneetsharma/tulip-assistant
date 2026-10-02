'use strict';
// Static audit of what is published to browsers (a freshly rendered copy of site/) and of the Worker configuration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../src/guards.js');
const { renderSite } = require('../scripts/build_site.js');
const { tmp, ROOT, EXAMPLE } = require('./helpers/example_runtime.js');

const PUB = tmp('assistant-site-');
renderSite(PUB);
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const EMAIL = G.CFG.public_contact.email;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)).map((x) => e.name + '/' + x) : [e.name]));

test('rendered site contains only the website files', () => {
  assert.deepStrictEqual(walk(PUB).sort(), ['404.html', '_headers', 'app.js', 'favicon.svg', 'index.html', 'styles.css']);
});

test('no unfilled template tokens remain', () => {
  for (const f of walk(PUB)) assert.ok(!/\{\{[a-z]+\}\}/.test(read(f)), f);
});

test('no knowledge text appears in browser assets', () => {
  const all = walk(PUB).map(read).join('\n');
  const kb = fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/);
  for (const line of kb) { const t = line.trim(); if (t.length >= 50) assert.ok(!all.includes(t), 'browser asset contains knowledge text: ' + t.slice(0, 60)); }
});

test('no credentials or secrets in browser assets or Worker config', () => {
  const all = [...walk(PUB).map(read), fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8')].join('\n');
  assert.ok(!/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|Bearer\s|api\.cloudflare\.com|\b[0-9a-f]{32}\b/i.test(all));
});

test('page: names the assistant and owner, shows the contact email and the mistakes notice', () => {
  const h = read('index.html');
  assert.ok(h.includes('<title>' + G.ASSISTANT + ', ' + G.OWNER + "'s AI assistant</title>"));
  assert.ok(h.includes('not to ' + G.OWNER));
  assert.ok(h.includes(G.ASSISTANT + ' may make mistakes'));
  assert.ok((h.match(new RegExp('mailto:' + EMAIL.replace(/\./g, '\\.'), 'g')) || []).length >= 2);
  assert.ok(h.includes(G.FIXED.welcome), 'built-in welcome text matches the configured welcome');
  assert.match(h, /id="new-chat"[^>]*>New chat</);
});

test('page: accessibility basics', () => {
  const h = read('index.html');
  assert.match(h, /<html lang="en">/);
  assert.match(h, /name="viewport" content="width=device-width, initial-scale=1/);
  assert.match(h, /role="log"/); assert.match(h, /aria-live="polite"/);
  assert.match(h, /<label for="composer-input"/);
  assert.match(h, /class="skip"/); assert.match(h, /<h1>/);
  const css = read('styles.css');
  assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /font-size: 16px/);
});

test('page: no inline scripts, handlers, styles or external resources (strict CSP compatible)', () => {
  for (const f of ['index.html', '404.html']) {
    const h = read(f);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(h), f + ' has an inline script');
    assert.ok(!/\son[a-z]+\s*=/i.test(h), f + ' has an inline event handler');
    assert.ok(!/\sstyle\s*=/i.test(h) && !/<style/i.test(h), f + ' has inline styles');
    assert.ok(!/(?:src|href)\s*=\s*"https?:\/\//i.test(h), f + ' loads an external resource');
  }
  assert.ok(!/https?:\/\//.test(read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('script: answers are rendered as text only', () => {
  const js = read('app.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setTimeout\(\s*['"]/.test(js));
  assert.ok(!/localStorage/.test(js));
  assert.match(js, /createTextNode/); assert.match(js, /textContent/);
  assert.match(js, /credentials: 'omit'/);
  assert.ok(!/fetch\(\s*['"]https?:/.test(js), 'only same-origin requests');
});

test('script: values containing quotes are escaped when rendered into JavaScript and HTML', () => {
  const real = JSON.parse(JSON.stringify(G.CFG));
  G.CFG.public_contact.email = 'a"b@example.com'; G.FIXED.welcome = "It's <b>\"hi\"</b>";
  const out = tmp('assistant-site-esc-');
  try {
    renderSite(out);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!html.includes('<b>"hi"</b>') && html.includes('&lt;b&gt;'));
    new Function(fs.readFileSync(path.join(out, 'app.js'), 'utf8').replace(/^[\s\S]*?(?=\bconst\b)/, ''));
  } catch (e) { if (!(e instanceof SyntaxError) || /Unexpected token/.test(e.message) === false) throw e; assert.fail('app.js is not valid JavaScript with special characters: ' + e.message); }
  finally { G.CFG.public_contact.email = real.public_contact.email; G.FIXED.welcome = real.fixed_text.welcome.replace(/\{\{assistant\}\}/g, G.ASSISTANT).replace(/\{\{owner\}\}/g, G.OWNER); }
});

test('script: loading, error, retry, usage-limit and new-chat behaviour exist', () => {
  const js = read('app.js');
  for (const needle of ['typing', 'role', 'alert', 'Try again', 'Could not reach', 'took too long', 'AbortController', 'reset', 'New chat started', 'data.message', 'history']) assert.ok(js.includes(needle), needle);
});

test('_headers: strict CSP and standard hardening for static files', () => {
  const h = read('_headers');
  assert.match(h, /Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(h));
  assert.match(h, /frame-ancestors 'none'/); assert.match(h, /X-Content-Type-Options: nosniff/); assert.match(h, /Referrer-Policy/);
});

function readJsonc(f) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  let out = '', inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { out += c; if (c === '\\') { out += t[++i]; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

test('wrangler.jsonc: free-plan Workers + static assets + Workers AI binding + SQLite Durable Object, nothing paid or exposed', () => {
  const w = readJsonc('wrangler.jsonc');
  assert.strictEqual(w.name, 'tulip-assistant');
  assert.strictEqual(w.main, 'worker/index.mjs');
  assert.match(w.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(w.preview_urls, false);
  assert.deepStrictEqual(w.assets, { directory: './public', binding: 'ASSETS', run_worker_first: ['/api/*'], html_handling: 'auto-trailing-slash', not_found_handling: '404-page' });
  assert.deepStrictEqual(w.ai, { binding: 'AI' });
  assert.deepStrictEqual(w.durable_objects.bindings, [{ name: 'LIMITER', class_name: 'UsageLimiter' }]);
  assert.deepStrictEqual(w.migrations, [{ tag: 'v1', new_sqlite_classes: ['UsageLimiter'] }]);
  for (const k of ['routes', 'route', 'zone_id', 'account_id', 'limits', 'usage_model', 'placement', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'queues', 'vectorize', 'hyperdrive', 'browser', 'send_email', 'secrets', 'triggers']) assert.ok(!(k in w), k + ' must not be configured');
  assert.ok(Number(w.vars.DAILY_NEURON_CAP) < 10000);
  assert.deepStrictEqual(Object.keys(w.vars).sort(), ['DAILY_NEURON_CAP', 'DAILY_REQUEST_CAP', 'LIMIT_PER_DAY', 'LIMIT_PER_HOUR', 'LIMIT_PER_MINUTE']);
  assert.deepStrictEqual(w.build, { command: 'node scripts/build_all.js' });
});

test('wrangler.jsonc vars match the code defaults', async () => {
  const { DEFAULT_LIMITS, limitsFromEnv } = await import('../worker/limits.mjs');
  assert.deepStrictEqual(limitsFromEnv(readJsonc('wrangler.jsonc').vars), { ...DEFAULT_LIMITS });
});

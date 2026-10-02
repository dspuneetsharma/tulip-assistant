// Local stand-in for the deployed site: serves the rendered site with the same CSP and routes /api/* through the real Worker code with FAKE
// bindings (a scripted model, in-memory SQLite). It never contacts Cloudflare. Used only to check the website and scripts offline.
// Run: node tests/helpers/dev_server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUB = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-site-'));
createRequire(import.meta.url)('../../scripts/build_site.js').renderSite(PUB);   // rendered from site/ with the names in config/guards.json
const { handle } = await import('../../worker/app.mjs');
const H = await import('./worker_env.mjs');
const { env } = H.makeEnv({
  limits: { perMinute: 40, perHour: 500, perDay: 900 },
  ai: async (model, input) => {
    const last = input.messages[input.messages.length - 1].content.toLowerCase();
    await new Promise((r) => setTimeout(r, 300));
    if (last.includes('boom')) throw new Error('internal error 500');
    return H.okResponse('Alex Example works with Python, machine learning and data analysis. (offline stand-in model; history messages: ' + input.messages.length + ')');
  },
});
const csp = fs.readFileSync(path.join(ROOT, 'site/_headers'), 'utf8').match(/Content-Security-Policy: (.*)/)[1];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const port = Number(process.argv[2]) || 8799;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + port);
  const chunks = []; for await (const c of req) chunks.push(c);
  if (url.pathname.startsWith('/api/')) {
    const r = await handle(new Request(url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '198.51.100.5' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), env, {});
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const f = path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'text/plain', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' });
  res.end(fs.readFileSync(f));
}).listen(port, () => console.log('offline dev server on http://localhost:' + port));

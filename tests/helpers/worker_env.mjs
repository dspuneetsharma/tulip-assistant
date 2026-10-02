// Fake Cloudflare bindings for Node tests: a Workers AI binding, a Durable Object namespace backed by a real SQLite database
// (node:sqlite), and a static-assets binding. No network, no credentials.
import { DatabaseSync } from 'node:sqlite';
import { LimitStore, DEFAULT_LIMITS } from '../../worker/limits.mjs';

export function sqlShim(db) {
  return {
    exec(q, ...b) {
      const t = q.trim().replace(/;\s*$/, '');
      if (!b.length && t.includes(';')) { db.exec(q); return { toArray: () => [] }; }
      const st = db.prepare(q);
      if (/^\s*select/i.test(q)) { const rows = st.all(...b); return { toArray: () => rows }; }
      st.run(...b); return { toArray: () => [] };
    },
  };
}

export const okResponse = (text, usage) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: usage || { prompt_tokens: 12500, completion_tokens: 80 },
  model: '@cf/qwen/qwen3-30b-a3b-fp8',
});

export function makeEnv(opts = {}) {
  const db = new DatabaseSync(':memory:');
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  const store = new LimitStore(sqlShim(db), limits);
  let clock = opts.now || (() => Date.now());
  const calls = { ai: [], admit: 0, settle: [], exhausted: 0 };
  const stub = {
    admit: async (ip) => { calls.admit += 1; if (opts.limiterDown) throw new Error('limiter down'); return store.admit(ip, clock()); },
    settle: async (day, n) => { calls.settle.push(n); return store.settle(day, n); },
    markExhausted: async (day) => { calls.exhausted += 1; return store.markExhausted(day); },
  };
  const env = {
    AI: { run: async (model, input) => { calls.ai.push({ model, input }); return opts.ai ? opts.ai(model, input, calls.ai.length) : okResponse('Alex Example has worked on demand forecasting and retrieval-augmented generation projects.'); } },
    LIMITER: { idFromName: (n) => n, get: () => stub },
    ASSETS: { fetch: async (req) => new Response('asset:' + new URL(req.url).pathname, { status: 200 }) },
  };
  return { env, calls, store, db, setClock: (f) => { clock = f; } };
}

export function chatRequest(body, { ip = '203.0.113.7', headers = {}, raw } = {}) {
  return new Request('https://tulip.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tulip.test', 'CF-Connecting-IP': ip, ...headers },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

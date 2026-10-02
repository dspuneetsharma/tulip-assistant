// Tulip's HTTP API. No Cloudflare-only imports here, so it can be tested in Node with fake bindings.
// Bindings used: AI (Workers AI), LIMITER (Durable Object namespace), ASSETS (static files). No secrets are needed or read.
import { TulipSession, Ledger, BudgetError, ModelError, guards as G, MODEL_CFG, KNOWLEDGE, REASONING_VARIANT } from './generated/tulip_core.mjs';
import { WorkersAIAdapter } from './ai_adapter.mjs';

const EMAIL = G.CFG.public_contact.email;
const OWNER = G.OWNER;
const ASSISTANT = G.ASSISTANT;
const MAX_BODY_BYTES = 40 * 1024;      // a full 6-turn history is well under 20 KB
const MAX_MESSAGE_CHARS = 4000;        // hard server cap; Tulip's own limit (config/model.json) is lower and answered politely
const MAX_HISTORY_ITEMS = 40;          // client history is untrusted; it is sanitised and trimmed to the last 6 turns anyway

export const MESSAGES = Object.freeze({
  rate: (wait) => 'You’ve sent a lot of messages in a short time. Please try again in ' + wait + '. If it is urgent, you can email ' + OWNER + ' at ' + EMAIL + '.',
  daily: '' + ASSISTANT + ' has reached its free daily usage limit and will be back after it resets (00:00 UTC). In the meantime, you can email ' + OWNER + ' directly at ' + EMAIL + '.',
  unavailable: ASSISTANT + ' is temporarily unavailable. Please try again in a little while, or email ' + OWNER + ' at ' + EMAIL + '.',
  badRequest: 'That request could not be processed. Please refresh the page and try again.',
  tooLarge: 'That message is too large. Please shorten it and try again.',
  forbidden: 'This request was not accepted.',
});

function humanWait(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return 'about ' + s + ' second' + (s === 1 ? '' : 's');
  if (s < 5400) return 'about ' + Math.ceil(s / 60) + ' minutes';
  return 'about ' + Math.ceil(s / 3600) + ' hours';
}

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
const json = (status, body, extra) => new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...(extra || {}) } });
const fail = (status, error, message, extra) => json(status, { error, message }, extra);

// Cheap per-isolate shedding of floods before any Durable Object call. Best effort only (isolates are not shared); the Durable Object is the real limit.
const shed = new Map();
function shedFlood(ip, now) {
  const arr = (shed.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); shed.set(ip, arr);
  if (shed.size > 500) { for (const [k, v] of shed) if (!v.length || now - v[v.length - 1] > 60000) shed.delete(k); }
  return arr.length > 20;
}

async function readLimited(request, max) {
  const len = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(len) && len > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch (_) { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function handleChat(request, env, ctx) {
  const url = new URL(request.url);
  const t0 = Date.now();
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', MESSAGES.badRequest, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return fail(403, 'forbidden', MESSAGES.forbidden);   // other websites cannot use this endpoint from a browser
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return fail(415, 'unsupported_media_type', MESSAGES.badRequest);
  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return fail(413, 'too_large', MESSAGES.tooLarge);
  let body;
  try { body = JSON.parse(raw); } catch (_) { return fail(400, 'bad_request', MESSAGES.badRequest); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_request', MESSAGES.badRequest);
  const message = body.message;
  if (typeof message !== 'string' || !message.trim()) return fail(400, 'bad_request', MESSAGES.badRequest);
  if (message.length > MAX_MESSAGE_CHARS) return fail(413, 'too_large', MESSAGES.tooLarge);
  const history = body.history == null ? [] : body.history;
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) return fail(400, 'bad_request', MESSAGES.badRequest);

  // The session is built before any limit is spent: invalid history (for example a client-supplied "system" message) is rejected here.
  let session;
  try {
    session = new TulipSession({
      adapter: new WorkersAIAdapter(env.AI, MODEL_CFG, { variant: REASONING_VARIANT }),
      modelCfg: MODEL_CFG,
      knowledge: KNOWLEDGE,
      ledger: new Ledger(MODEL_CFG, { persist: false }),
      seedHistory: history,
    });
  } catch (e) {
    if (e instanceof G.ClientInstructionError) return fail(400, 'bad_request', MESSAGES.badRequest);
    throw e;
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (shedFlood(ip, t0)) return fail(429, 'rate_limited', MESSAGES.rate('a minute'), { 'Retry-After': '60' });

  // Per-visitor and global limits (Durable Object). If the limiter cannot be reached the request is refused: never spend the free allocation unmetered.
  const limiter = env.LIMITER.get(env.LIMITER.idFromName('global'));
  let adm;
  try { adm = await limiter.admit(ip); } catch (_) { return fail(503, 'unavailable', MESSAGES.unavailable, { 'Retry-After': '30' }); }
  if (!adm.ok) {
    if (adm.reason === 'daily_limit') return fail(429, 'daily_limit', MESSAGES.daily, { 'Retry-After': String(adm.retryAfter) });
    return fail(429, 'rate_limited', MESSAGES.rate(humanWait(adm.retryAfter)), { 'Retry-After': String(adm.retryAfter) });
  }
  const settle = (neurons) => {
    const p = Promise.resolve().then(() => limiter.settle(adm.day, neurons)).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    return p;
  };

  let result;
  try {
    result = await session.ask(message);
  } catch (e) {
    await settle(0);
    if (e instanceof BudgetError) return fail(503, 'unavailable', MESSAGES.unavailable);
    throw e;
  }
  const { text, meta } = result;
  await settle(meta.est_neurons || 0);
  console.log(JSON.stringify({ evt: 'chat', path: meta.path, status: meta.status, neurons: Math.round((meta.est_neurons || 0) * 10) / 10, ms: Date.now() - t0 })); // no message content, no IP

  if (meta.status === 'model_error:daily_limit') {
    try { await limiter.markExhausted(adm.day); } catch (_) { /* best effort */ }
    return fail(429, 'daily_limit', MESSAGES.daily, { 'Retry-After': String(3600) });
  }
  if (meta.path === 'error-fallback' || !text) return fail(502, 'model_unavailable', text || MESSAGES.unavailable);
  return json(200, { reply: text, history: session.history });
}

export async function handle(request, env, ctx) {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/api/chat') return await handleChat(request, env, ctx);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json(200, { assistant: ASSISTANT, owner: OWNER, welcome: G.FIXED.welcome, contactEmail: EMAIL, maxMessageChars: MODEL_CFG.history.max_user_chars }, { 'Cache-Control': 'public, max-age=300' });
    }
    if (url.pathname === '/api/health' && request.method === 'GET') return json(200, { ok: true });
    if (url.pathname.startsWith('/api/')) return fail(404, 'not_found', MESSAGES.badRequest);
    return env.ASSETS.fetch(request);
  } catch (e) {
    console.log(JSON.stringify({ evt: 'error', name: e && e.name, message: String((e && e.message) || e).slice(0, 200) }));
    return fail(500, 'server_error', MESSAGES.unavailable);
  }
}

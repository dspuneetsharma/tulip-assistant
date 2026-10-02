// Usage limits, kept free of Cloudflare imports so they can be tested in Node.
// LimitStore runs inside ONE Durable Object (SQLite-backed, available on the Workers Free plan). It enforces
//   * a per-visitor limit (sliding windows: minute / hour / day), using a salted hash of the IP address (the raw IP is never stored),
//   * a global daily budget of estimated Workers AI Neurons and a global daily request cap, so the free allocation cannot be exhausted by abuse.
// Rows are only written for ADMITTED requests, so a flood of blocked requests costs reads, not writes.

export const DEFAULT_LIMITS = Object.freeze({
  perMinute: 6,
  perHour: 40,
  perDay: 120,
  dailyNeuronCap: 8000,      // Cloudflare's free allocation is 10,000 Neurons/day; this keeps headroom for estimate error
  dailyRequestCap: 400,
  reserveNeurons: 100,       // reserved at admission; replaced by the measured figure afterwards (a normal answer is ~60-75)
});

export function limitsFromEnv(env) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const e = env || {};
  return {
    perMinute: num(e.LIMIT_PER_MINUTE, DEFAULT_LIMITS.perMinute),
    perHour: num(e.LIMIT_PER_HOUR, DEFAULT_LIMITS.perHour),
    perDay: num(e.LIMIT_PER_DAY, DEFAULT_LIMITS.perDay),
    dailyNeuronCap: num(e.DAILY_NEURON_CAP, DEFAULT_LIMITS.dailyNeuronCap),
    dailyRequestCap: num(e.DAILY_REQUEST_CAP, DEFAULT_LIMITS.dailyRequestCap),
    reserveNeurons: num(e.RESERVE_NEURONS, DEFAULT_LIMITS.reserveNeurons),
  };
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const secondsToUtcMidnight = (ms) => { const d = new Date(ms); return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ms) / 1000)); };

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export class LimitStore {
  // sql: ctx.storage.sql (or a test shim) with exec(query, ...bindings) -> cursor with toArray()
  constructor(sql, limits = DEFAULT_LIMITS) {
    this.sql = sql;
    this.limits = limits;
    this.lastPurge = 0;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, ts INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS hits_ip_ts ON hits (ip, ts);' +
      'CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, neurons REAL NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0);' +
      'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);'
    );
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'salt'").toArray()[0];
    if (row) this.salt = row.v;
    else {
      this.salt = [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('salt', ?)", this.salt);
    }
  }

  _usage(day) {
    const r = this.sql.exec('SELECT neurons, requests FROM usage WHERE day = ?', day).toArray()[0];
    return r ? { neurons: Number(r.neurons), requests: Number(r.requests) } : { neurons: 0, requests: 0 };
  }

  // Returns { ok: true, day } or { ok: false, reason, retryAfter } (retryAfter in seconds).
  async admit(ip, now = Date.now()) {
    const L = this.limits;
    const key = await sha256Hex(this.salt + '|' + String(ip || 'unknown'));
    // No awaits below: the check and the write happen as one step.
    if (now - this.lastPurge > 600000) {
      this.sql.exec('DELETE FROM hits WHERE ts < ?', now - 86400000);
      this.sql.exec('DELETE FROM usage WHERE day < ?', utcDay(now - 3 * 86400000));
      this.lastPurge = now;
    }
    const day = utcDay(now);
    const u = this._usage(day);
    if (u.requests >= L.dailyRequestCap || u.neurons + L.reserveNeurons > L.dailyNeuronCap) {
      return { ok: false, reason: 'daily_limit', retryAfter: secondsToUtcMidnight(now) };
    }
    const c = this.sql.exec(
      'SELECT COALESCE(SUM(ts > ?), 0) AS m, COALESCE(SUM(ts > ?), 0) AS h, COUNT(*) AS d FROM hits WHERE ip = ? AND ts > ?',
      now - 60000, now - 3600000, key, now - 86400000
    ).toArray()[0];
    const windows = [
      { reason: 'rate_minute', count: Number(c.m), limit: L.perMinute, span: 60000 },
      { reason: 'rate_hour', count: Number(c.h), limit: L.perHour, span: 3600000 },
      { reason: 'rate_day', count: Number(c.d), limit: L.perDay, span: 86400000 },
    ];
    for (const w of windows) {
      if (w.count >= w.limit) {
        // The hit that must age out of the window before another request fits.
        const r = this.sql.exec('SELECT ts FROM hits WHERE ip = ? AND ts > ? ORDER BY ts DESC LIMIT 1 OFFSET ?', key, now - w.span, w.limit - 1).toArray()[0];
        const free = r ? Number(r.ts) + w.span - now : w.span;
        return { ok: false, reason: w.reason, retryAfter: Math.max(1, Math.ceil(free / 1000)) };
      }
    }
    this.sql.exec('INSERT INTO hits (ip, ts) VALUES (?, ?)', key, now);
    this.sql.exec('INSERT INTO usage (day, neurons, requests) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons, requests = requests + 1', day, L.reserveNeurons);
    return { ok: true, day };
  }

  // Replaces the reservation made at admission with the measured figure.
  settle(day, actualNeurons) {
    const delta = (Number(actualNeurons) || 0) - this.limits.reserveNeurons;
    this.sql.exec('UPDATE usage SET neurons = MAX(0, neurons + ?) WHERE day = ?', delta, day);
    return true;
  }

  // Cloudflare itself reported the free allocation as used up (for example by other uses of the same account): stop for today.
  markExhausted(day) {
    this.sql.exec('INSERT INTO usage (day, neurons, requests) VALUES (?, ?, 0) ON CONFLICT(day) DO UPDATE SET neurons = MAX(neurons, excluded.neurons)', day, this.limits.dailyNeuronCap);
    return true;
  }

  status(now = Date.now()) {
    const day = utcDay(now);
    return { day, ...this._usage(day), limits: this.limits };
  }
}

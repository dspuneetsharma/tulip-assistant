// The Durable Object that holds usage counters. One instance ("global"). SQLite-backed, which is available on the Workers Free plan.
import { DurableObject } from 'cloudflare:workers';
import { LimitStore, limitsFromEnv } from './limits.mjs';

export class UsageLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new LimitStore(ctx.storage.sql, limitsFromEnv(env));
  }
  async admit(ip) { return this.store.admit(ip, Date.now()); }
  async settle(day, actualNeurons) { return this.store.settle(day, actualNeurons); }
  async markExhausted(day) { return this.store.markExhausted(day); }
  async status() { return this.store.status(Date.now()); }
}

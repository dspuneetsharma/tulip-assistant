'use strict';
// Local usage ledger (git-ignored, logs/). Estimated Neurons only. The Cloudflare dashboard is authoritative.
// fs/path are required lazily and only for the Node CLI (persist: true), so this file also bundles into the Worker.
const ledgerFile = () => require('path').join(require('path').resolve(__dirname, '..'), 'logs', 'usage_ledger.json');

class BudgetError extends Error {
  constructor(message) { super(message); this.name = 'BudgetError'; }
}

function estimateNeurons(inputTokens, outputTokens, pricing) {
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1e6;
}

// Cloudflare's daily allowance resets at 00:00 UTC.
const today = () => new Date().toISOString().slice(0, 10);

function load() {
  try { return JSON.parse(require('fs').readFileSync(ledgerFile(), 'utf8')); } catch (_) { return {}; }
}
function save(d) {
  try { const fs = require('fs'); const f = ledgerFile(); fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (_) { /* best effort */ }
}

class Ledger {
  constructor(cfg, { persist = true } = {}) {
    this.cfg = cfg;
    this.persist = persist;
    this.session = { requests: 0, input_tokens: 0, output_tokens: 0, est_neurons: 0 };
    this.data = persist ? load() : {};
  }
  todayEstimate() { return (this.data[today()] || {}).est_neurons || 0; }
  // Upper-bound pre-call estimate: prompt chars / 3.5 + full max_tokens output.
  preflight(promptChars, maxTokens) {
    return estimateNeurons(Math.ceil(promptChars / 3.5), maxTokens, this.cfg.pricing_neurons_per_million_tokens);
  }
  check(promptChars, maxTokens, sessionCap) {
    const pre = this.preflight(promptChars, maxTokens);
    const cap = this.cfg.local_daily_cap_estimated_neurons;
    if (this.todayEstimate() + pre > cap) {
      throw new BudgetError('Local daily cap reached: ~' + Math.round(this.todayEstimate()) + ' estimated Neurons used today (cap ' + cap + '). Nothing was sent. Edit config/model.json to change the cap.');
    }
    if (sessionCap != null && this.session.est_neurons + pre > sessionCap) {
      throw new BudgetError('Run budget reached: ~' + Math.round(this.session.est_neurons) + ' estimated Neurons used this run (budget ' + sessionCap + ').');
    }
    return pre;
  }
  record(usage) {
    const inp = usage.prompt_tokens || 0;
    const out = usage.completion_tokens || 0;
    const n = estimateNeurons(inp, out, this.cfg.pricing_neurons_per_million_tokens);
    this.session.requests += 1; this.session.input_tokens += inp; this.session.output_tokens += out; this.session.est_neurons += n;
    const d = today();
    const e = this.data[d] || { requests: 0, input_tokens: 0, output_tokens: 0, est_neurons: 0 };
    e.requests += 1; e.input_tokens += inp; e.output_tokens += out; e.est_neurons += n;
    this.data[d] = e;
    if (this.persist) save(this.data);
    return n;
  }
}

module.exports = { Ledger, BudgetError, estimateNeurons };

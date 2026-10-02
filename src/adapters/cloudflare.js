'use strict';
// Replaceable model adapter: Cloudflare Workers AI (REST). Credentials come only from environment variables.
// Reasoning text is never returned, logged or printed: only its presence and length are reported.
const fs = require('fs');
const path = require('path');
const { ModelError } = require('./errors.js');
const { cleanContent, extract, describeShape } = require('./parse.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CHOICES_FILE = path.join(ROOT, 'config', 'local_choices.json');

function loadChoices() {
  try { return JSON.parse(fs.readFileSync(CHOICES_FILE, 'utf8')); } catch (_) { return {}; }
}

function scrub(text, secrets) {
  let s = String(text);
  for (const v of secrets) if (v && v.length > 6) s = s.split(v).join('[redacted]');
  return s;
}

class CloudflareAdapter {
  constructor(modelCfg, { variant, endpointStyle } = {}) {
    this.cfg = modelCfg;
    const c = loadChoices();
    this.variant = variant || c.reasoning_variant || 'no_think_suffix'; // Qwen3 default; scripts/probe_reasoning.js can record another choice
    this.endpointStyle = endpointStyle || c.endpoint_style || modelCfg.endpoint_style || 'openai';
    this.accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
    this.token = process.env.CLOUDFLARE_API_TOKEN || '';
  }

  hasCredentials() { return !!(this.accountId && this.token); }

  url() {
    const base = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(this.accountId) + '/ai';
    return this.endpointStyle === 'run' ? base + '/run/' + this.cfg.model : base + '/v1/chat/completions';
  }

  buildBody(messages, maxTokens, variant) {
    let msgs = messages.map((m) => ({ role: m.role, content: m.content }));
    if (variant === 'no_think_suffix') {
      const i = msgs.map((m) => m.role).lastIndexOf('user');
      if (i >= 0) msgs[i] = { role: 'user', content: msgs[i].content + '\n/no_think' };
    }
    const body = { messages: msgs, max_tokens: maxTokens, temperature: this.cfg.temperature };
    if (this.endpointStyle !== 'run') body.model = this.cfg.model;
    if (variant === 'chat_template_kwargs') body.chat_template_kwargs = { enable_thinking: false };
    return body;
  }

  // One HTTP call, no retries. Returns a normalised result.
  async _once({ messages, maxTokens, variant }) {
    if (!this.hasCredentials()) throw new ModelError('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set in this terminal.', { kind: 'no_credentials' });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeout_ms);
    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(this.url(), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildBody(messages, maxTokens, variant)),
        signal: ctl.signal,
      });
      text = await res.text();
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Request timed out after ' + this.cfg.timeout_ms + ' ms' : 'Network error: ' + scrub(e.message, [this.token, this.accountId]);
      throw new ModelError(msg, { kind: 'network', retryable: true });
    } finally { clearTimeout(timer); }
    const latencyMs = Date.now() - t0;

    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* non-JSON */ }
    if (!res.ok || (body && body.success === false)) {
      const errs = (body && (body.errors || (body.error ? [body.error] : []))) || [];
      const first = errs[0] || {};
      const detail = scrub((first.message || (typeof body === 'object' && body && body.message) || text || '').toString().slice(0, 300), [this.token, this.accountId]);
      const code = first.code != null ? first.code : null;
      const daily = /daily|neuron|free allocation|allocation/i.test(detail) || code === 4006;
      let kind = 'http_error';
      if (res.status === 401 || res.status === 403) kind = 'auth';
      else if (res.status === 404) kind = 'not_found';
      else if (daily) kind = 'daily_limit';
      else if (res.status === 429) kind = 'rate_limit';
      throw new ModelError('HTTP ' + res.status + (code != null ? ' (code ' + code + ')' : '') + ': ' + detail, {
        status: res.status, kind, retryable: (res.status >= 500 || kind === 'rate_limit') && kind !== 'daily_limit',
      });
    }
    if (!body) throw new ModelError('Response was not JSON.', { status: res.status, kind: 'bad_response' });

    const x = extract(body);
    const cleaned = cleanContent(x.content);
    const truncatedByLength = x.finishReason === 'length';
    let status = 'ok';
    if (!cleaned.text) status = (cleaned.info.unclosedThink || truncatedByLength) ? 'truncated_no_answer' : 'empty';
    else if (truncatedByLength) status = 'truncated';
    return {
      text: cleaned.text,                // reasoning already removed
      status,                            // ok | truncated | truncated_no_answer | empty
      finishReason: x.finishReason,
      usage: x.usage || { prompt_tokens: 0, completion_tokens: 0 },
      usageReported: !!x.usage,
      reasoning: { field_chars: x.reasoningChars, think_tags: cleaned.info.hadThinkTags, unclosed: cleaned.info.unclosedThink },
      latencyMs,
      model: x.model,
      shape: describeShape(body),
    };
  }

  // With bounded retries for transient failures only (network, 5xx, rate limit).
  async complete({ messages, maxTokens, variant }) {
    const v = variant || this.variant;
    let attempt = 0;
    for (;;) {
      try { const r = await this._once({ messages, maxTokens, variant: v }); r.transportRetries = attempt; return r; }
      catch (e) {
        if (!(e instanceof ModelError) || !e.retryable || attempt >= this.cfg.max_retries) throw e;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}

module.exports = { CloudflareAdapter, ModelError, cleanContent, extract, describeShape, loadChoices, CHOICES_FILE };

// Model adapter for the Workers AI binding. Same contract as src/adapters/cloudflare.js (complete() -> normalised result), no credentials:
// the binding is attached by Cloudflare at runtime, so there is no token anywhere in this project.
import { ModelError, cleanContent, extract } from './generated/tulip_core.mjs';

// Maps a thrown binding error to the same kinds the Node adapter uses. Messages are never shown to visitors.
export function classifyAiError(err) {
  const msg = String((err && err.message) || err || '');
  if (/4006|daily|neuron|free allocation|allocation|quota/i.test(msg)) return { kind: 'daily_limit', retryable: false };
  if (/429|rate.?limit|too many|3040|capacity/i.test(msg)) return { kind: 'rate_limit', retryable: true };
  if (/timed? ?out|timeout|network|fetch failed|5\d\d|internal|unavailable/i.test(msg)) return { kind: 'network', retryable: true };
  if (/401|403|auth|permission|forbidden/i.test(msg)) return { kind: 'auth', retryable: false };
  if (/5007|no such model|not found|404/i.test(msg)) return { kind: 'not_found', retryable: false };
  return { kind: 'http_error', retryable: false };
}

export class WorkersAIAdapter {
  constructor(ai, modelCfg, { variant } = {}) {
    this.ai = ai;
    this.cfg = modelCfg;
    this.variant = variant || 'none';
  }

  buildInput(messages, maxTokens, variant) {
    const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
    if (variant === 'no_think_suffix') {
      const i = msgs.map((m) => m.role).lastIndexOf('user');
      if (i >= 0) msgs[i] = { role: 'user', content: msgs[i].content + '\n/no_think' };
    }
    return { messages: msgs, max_tokens: maxTokens, temperature: this.cfg.temperature };
  }

  async _once({ messages, maxTokens, variant }) {
    const t0 = Date.now();
    let timer;
    let raw;
    try {
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), this.cfg.timeout_ms); });
      raw = await Promise.race([this.ai.run(this.cfg.model, this.buildInput(messages, maxTokens, variant)), timeout]);
    } catch (e) {
      const c = classifyAiError(e);
      throw new ModelError('Workers AI error (' + c.kind + ')', { kind: c.kind, retryable: c.retryable });
    } finally { clearTimeout(timer); }
    const latencyMs = Date.now() - t0;
    if (raw == null || typeof raw !== 'object') throw new ModelError('Unexpected Workers AI response.', { kind: 'bad_response' });
    const x = extract(raw);
    const cleaned = cleanContent(x.content);
    const truncatedByLength = x.finishReason === 'length';
    let status = 'ok';
    if (!cleaned.text) status = (cleaned.info.unclosedThink || truncatedByLength) ? 'truncated_no_answer' : 'empty';
    else if (truncatedByLength) status = 'truncated';
    return {
      text: cleaned.text, status, finishReason: x.finishReason,
      usage: x.usage || { prompt_tokens: 0, completion_tokens: 0 }, usageReported: !!x.usage,
      reasoning: { field_chars: x.reasoningChars, think_tags: cleaned.info.hadThinkTags, unclosed: cleaned.info.unclosedThink },
      latencyMs, model: x.model,
    };
  }

  async complete({ messages, maxTokens, variant }) {
    const v = variant || this.variant;
    let attempt = 0;
    for (;;) {
      try { const r = await this._once({ messages, maxTokens, variant: v }); r.transportRetries = attempt; return r; }
      catch (e) {
        if (!(e instanceof ModelError) || !e.retryable || attempt >= this.cfg.max_retries) throw e;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
}

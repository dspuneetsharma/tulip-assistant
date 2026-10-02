'use strict';
// Scripted adapter for offline structural tests. NOT a model. Results obtained with it are labelled "mock".
class MockAdapter {
  constructor(script) { this.script = script || []; this.calls = []; this.variant = 'none'; }
  hasCredentials() { return true; }
  async complete({ messages, maxTokens, variant }) {
    this.calls.push({ messages, maxTokens, variant });
    const next = this.script.length ? this.script.shift() : { text: 'Mock answer.' };
    const r = typeof next === 'function' ? next({ messages, maxTokens }) : next;
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text: r.text != null ? r.text : '', status: r.status || (r.text ? 'ok' : 'empty'), finishReason: r.finishReason || 'stop',
      usage: r.usage || { prompt_tokens: Math.round(promptChars / 4), completion_tokens: Math.round(((r.text || '').length) / 4) },
      usageReported: true, reasoning: { field_chars: 0, think_tags: false, unclosed: false }, latencyMs: 1, model: 'mock', shape: {}, transportRetries: 0,
    };
  }
}
module.exports = { MockAdapter };

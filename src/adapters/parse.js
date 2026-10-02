'use strict';
// Pure helpers for model responses. Shared by the Node (REST) adapter and the Worker (AI binding) adapter. No I/O.

// Removes reasoning blocks from content. Returns cleaned text and status info (never the reasoning text itself).
function cleanContent(raw) {
  let content = typeof raw === 'string' ? raw : '';
  const info = { hadThinkTags: false, unclosedThink: false };
  if (/<think>/i.test(content)) {
    info.hadThinkTags = true;
    if (!/<\/think>/i.test(content)) { info.unclosedThink = true; content = content.replace(/<think>[\s\S]*$/i, ''); }
    else content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  } else if (/<\/think>/i.test(content)) {
    // Some chat templates drop the opening tag and only emit the closing one.
    info.hadThinkTags = true;
    content = content.slice(content.toLowerCase().lastIndexOf('</think>') + '</think>'.length);
  }
  return { text: content.trim(), info };
}

function extract(body) {
  const r = (body && typeof body === 'object' && body.result && typeof body.result === 'object') ? body.result : body;
  const choice = r && Array.isArray(r.choices) ? r.choices[0] : null;
  const msg = (choice && choice.message) || {};
  let content = msg.content != null ? msg.content : (choice && choice.text != null ? choice.text : (r && r.response != null ? r.response : ''));
  if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  const reasoning = msg.reasoning_content != null ? msg.reasoning_content : (msg.reasoning != null ? msg.reasoning : null);
  return {
    content: typeof content === 'string' ? content : '',
    reasoningChars: typeof reasoning === 'string' ? reasoning.length : (reasoning ? 1 : 0),
    finishReason: (choice && (choice.finish_reason || choice.finishReason)) || null,
    usage: (r && r.usage) || null,
    model: (r && r.model) || null,
  };
}

// Key/type tree of a response with string lengths only (no string values). Safe to print.
function describeShape(v, depth = 0) {
  if (v == null) return String(v);
  if (typeof v === 'string') return 'string(' + v.length + ')';
  if (typeof v !== 'object') return typeof v;
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.length ? '[' + v.length + ' × ' + describeShape(v[0], depth + 1) + ']' : '[]';
  const o = {};
  for (const k of Object.keys(v)) o[k] = describeShape(v[k], depth + 1);
  return o;
}

module.exports = { cleanContent, extract, describeShape };

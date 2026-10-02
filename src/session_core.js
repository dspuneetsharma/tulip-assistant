'use strict';
// Tulip's session core: bounded history and guards around a model adapter. No file system access, so the same file runs in
// the Node CLI and inside the Cloudflare Worker.
const G = require('./guards.js');
const { observe } = require('./observations.js');
const { BudgetError } = require('./ledger.js');
const { ModelError } = require('./adapters/errors.js');

class TulipSession {
  constructor({ adapter, modelCfg, knowledge, ledger, runBudget = null, seedHistory = null }) {
    this.adapter = adapter;
    this.cfg = modelCfg;
    this.knowledge = knowledge;
    this.ledger = ledger;
    this.runBudget = runBudget;
    this.flags = G.CFG.runtime_flags;
    this.history = G.sanitizeHistory(seedHistory, modelCfg.history, this.flags); // throws ClientInstructionError on system roles
    this.turns = 0;
  }

  _remember(userText, assistantText) {
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: assistantText });
    this.history = this.history.slice(-(this.cfg.history.max_turns * 2));
  }

  async _call(messages, maxTokens, variant, meta) {
    this.ledger.check(messages.reduce((n, m) => n + m.content.length, 0), maxTokens, this.runBudget); // messages already include the system prompt
    const r = await this.adapter.complete({ messages, maxTokens, variant });
    const usage = r.usageReported ? r.usage : {
      prompt_tokens: Math.round(messages.reduce((n, m) => n + m.content.length, 0) / 4),
      completion_tokens: Math.round(r.text.length / 4),
    };
    meta.usage.prompt_tokens += usage.prompt_tokens || 0;
    meta.usage.completion_tokens += usage.completion_tokens || 0;
    meta.usage.reported = meta.usage.reported && r.usageReported;
    meta.est_neurons += this.ledger.record(usage);
    meta.latencyMs += r.latencyMs;
    meta.calls.push({ status: r.status, finish: r.finishReason, variant: variant || this.adapter.variant, latencyMs: r.latencyMs, reasoning: r.reasoning, usage });
    return r;
  }

  // Returns { text, meta }. Never throws for model-side problems; throws BudgetError / ClientInstructionError.
  async ask(userTextRaw) {
    const meta = { path: 'model', guards: [], latencyMs: 0, usage: { prompt_tokens: 0, completion_tokens: 0, reported: true }, est_neurons: 0, calls: [], retried: false, status: 'ok' };
    const userText = String(userTextRaw == null ? '' : userTextRaw).trim();
    if (!userText) return { text: '', meta: { ...meta, path: 'empty' } };
    if (userText.length > this.cfg.history.max_user_chars) {
      return { text: G.FIXED.authored_input_too_long, meta: { ...meta, path: 'guard-length' } };
    }
    this.turns += 1;

    const lastAssistant = [...this.history].reverse().find((m) => m.role === 'assistant');
    const afterFinanceRefusal = !!(lastAssistant && lastAssistant.content === G.FIXED.financial_refusal);

    // Guard 1: personal finances (including follow-ups about "that figure") are refused without calling the model.
    if (G.isPersonalFinanceQuestion(userText) || G.isFinanceFollowUp(userText, afterFinanceRefusal)) {
      this._remember(G.FINANCE_PLACEHOLDER, G.FIXED.financial_refusal);
      return { text: G.FIXED.financial_refusal, meta: { ...meta, path: 'guard-financial', guards: ['financial_input'] } };
    }

    // Guard 2: requests to leave or relay a message get a truthful fixed answer while messaging is unavailable.
    if (!this.flags.message_saving && G.isMessageRequest(userText)) {
      this._remember('[visitor asked to leave a message for ' + G.OWNER + ']', G.FIXED.authored_message_request_no_messaging);
      return { text: G.FIXED.authored_message_request_no_messaging, meta: { ...meta, path: 'guard-message-request', guards: ['message_request_fixed'] } };
    }

    const farewell = G.isFarewell(userText);

    // Guard 3: a plain goodbye gets a fixed close (no model call, no new questions).
    if (G.isPureFarewell(userText)) {
      const text = (G.FIXED.authored_farewell + ' ' + G.FIXED.farewell_suffix).trim();
      this._remember(userText, text);
      return { text, meta: { ...meta, path: 'guard-farewell', guards: ['farewell_fixed'] } };
    }

    // Guard 4: an organisation introduction with no question gets a plain acknowledgement and "how can I help".
    // When the assistant has just asked the visitor a question (for example an interviewer question), the reply is an answer to it, not an introduction.
    const answeringAssistant = !!(lastAssistant && /\?["”’)]*\s*$/.test(lastAssistant.content.trim()) && !/How can I help you today\?$/.test(lastAssistant.content.trim()));
    if (!answeringAssistant && G.isIntroOnly(userText)) {
      const text = G.FIXED.authored_intro_ack;
      this._remember(userText, text);
      return { text, meta: { ...meta, path: 'guard-intro-ack', guards: ['intro_ack_fixed'] } };
    }
    const introWithQuestion = !answeringAssistant && G.isOrgIntro(userText);

    const red = G.redactSourceTerms(userText);
    if (red.redacted) meta.guards.push('source_title_redacted_in_input');

    // The model sees neither an AI product name nor the withheld title: both are replaced by neutral placeholders. The approved facts
    // establish that coding assistance was used, not which tool; the title is withheld from the public profile. How to answer questions
    // about either is in the system prompt; the model answers them like any other question.
    const rt = G.redactAssistantTools(red.text);
    if (rt.redacted) meta.guards.push('tool_name_redacted_in_input');
    const questionForModel = rt.text;
    const introNote = introWithQuestion
      ? '\n\n[Application note, not written by the visitor: the visitor has introduced themselves or their organisation. Start with one short, natural sentence acknowledging the introduction (do not welcome them again and do not say who you are), then answer their question.]'
      : '';
    const requestText = questionForModel + introNote;

    const sys = { role: 'system', content: this.knowledge.system };
    // Earlier answers stay as context (they resolve "that pipeline", "those checks"), but a contact sentence is dropped from the copy the model
    // reads: it is not content about the owner, and a model that sees it tends to copy it into answers that do not need it.
    const stripContact = (t) => { const kept = G.splitSentences(t).filter((sn) => !sn.includes(G.CFG.public_contact.email)); return kept.length ? kept.join(' ') : t; };
    const past = this.history.map((m) => ({ ...m, content: m.role === 'assistant' ? stripContact(m.content) : m.content }));
    let r;
    try {
      r = await this._call([sys, ...past, { role: 'user', content: requestText }], this.cfg.max_tokens, undefined, meta);
      if ((r.status === 'empty' || r.status === 'truncated_no_answer') && this.cfg.max_retries > 0) {
        meta.retried = true; meta.guards.push('retry_after_' + r.status);
        // One bounded retry: larger budget, and force the no-think switch if it was not already in use.
        const v = this.adapter.variant === 'none' ? 'no_think_suffix' : undefined;
        r = await this._call([sys, ...past, { role: 'user', content: requestText }], this.cfg.retry_max_tokens, v, meta);
      }
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      if (e instanceof ModelError) {
        meta.status = 'model_error:' + e.kind; meta.error = e.message; meta.path = 'error-fallback';
        return { text: G.FIXED.authored_error_fallback, meta };
      }
      throw e;
    }

    let text = r.text;
    if (r.status === 'empty' || r.status === 'truncated_no_answer') {
      meta.status = 'failed_' + r.status; meta.path = 'error-fallback';
      return { text: G.FIXED.authored_error_fallback, meta };
    }
    if (r.status === 'truncated') { text = G.trimToLastSentence(text); meta.status = 'truncated_trimmed'; meta.guards.push('truncated_trimmed'); }
    meta.first_draft = text;
    meta.pre_guard_text = text;

    // Output safeguards: clear failures are removed; a stray closing phrase is stripped.
    const g = G.applyOutputGuards(text, { flags: this.flags, farewell, afterFinanceRefusal });
    meta.guards.push(...g.triggered);
    if (!g.text) {
      // The model only repeated the welcome or a stray greeting. If the visitor was introducing themselves, acknowledge that.
      if (G.isOrgIntro(userText)) { meta.guards.push('intro_ack_after_empty'); this._remember(questionForModel, G.FIXED.authored_intro_ack); return { text: G.FIXED.authored_intro_ack, meta: { ...meta, path: 'guard-intro-ack' } }; }
      meta.status = 'failed_empty_after_guards'; meta.path = 'error-fallback'; return { text: G.FIXED.authored_error_fallback, meta };
    }
    let finalText = g.text;
    meta.observations = observe(finalText, { question: userText, facts: this.knowledge.facts });   // advisory only: never changes the answer
    this._remember(questionForModel, finalText);
    return { text: finalText, meta };
  }
}

module.exports = { TulipSession };

'use strict';
// Stage 1, step 2: test reasoning controls on the real endpoint with 3 tiny requests (one per variant).
// Reports only lengths, flags and token counts. Reasoning text is never printed or stored.
const fs = require('fs');
const { CloudflareAdapter, ModelError, CHOICES_FILE, loadChoices } = require('../src/adapters/cloudflare.js');
const { loadModelCfg } = require('../src/tulip.js');
const { Ledger } = require('../src/ledger.js');

(async () => {
  const cfg = loadModelCfg();
  const choices = loadChoices();
  if (!choices.access_verified) { console.log('Run "node scripts/check_access.js" first (it must succeed).'); process.exit(2); }
  const adapter = new CloudflareAdapter(cfg);
  const ledger = new Ledger(cfg);
  const variants = ['none', 'no_think_suffix', 'chat_template_kwargs'];
  const messages = [
    { role: 'system', content: 'You are a concise assistant. Give only the final answer.' },
    { role: 'user', content: 'A recruiter asks: "Does he know Python?" Reply in one short sentence: Yes, the person uses Python.' },
  ];
  const rows = [];
  console.log('Probing', variants.length, 'variants (max_tokens 300 each)...\n');
  for (const v of variants) {
    try {
      const r = await adapter.complete({ messages, maxTokens: 300, variant: v });
      ledger.record(r.usage);
      const reasoningEvidence = r.reasoning.field_chars > 0 || r.reasoning.think_tags;
      rows.push({ variant: v, accepted: true, status: r.status, finish: r.finishReason, completion_tokens: r.usage.completion_tokens, prompt_tokens: r.usage.prompt_tokens, latencyMs: r.latencyMs, reasoning_field_chars: r.reasoning.field_chars, think_tags: r.reasoning.think_tags, reasoning_evidence: reasoningEvidence, answer_chars: r.text.length });
    } catch (e) {
      rows.push({ variant: v, accepted: false, error: e.message.slice(0, 200), kind: e instanceof ModelError ? e.kind : 'error' });
      if (e instanceof ModelError && (e.kind === 'auth' || e.kind === 'daily_limit')) break;
    }
  }
  for (const r of rows) console.log(JSON.stringify(r));

  const good = rows.filter((r) => r.accepted && r.status === 'ok');
  good.sort((a, b) => (a.reasoning_evidence - b.reasoning_evidence) || (a.completion_tokens - b.completion_tokens) || (a.variant === 'none' ? -1 : 1));
  const pick = good[0] ? good[0].variant : 'none';
  const anyEvidence = rows.some((r) => r.reasoning_evidence);
  console.log('\nChosen reasoning variant:', pick);
  console.log('Reasoning evidence seen in at least one variant:', anyEvidence);
  fs.writeFileSync(CHOICES_FILE, JSON.stringify({ ...choices, reasoning_variant: pick, reasoning_probe: rows, probed_at: new Date().toISOString() }, null, 2) + '\n');
  console.log('Saved to config/local_choices.json. Next: node src/cli.js  (or node scripts/run_eval.js)');
})();

'use strict';
// Stage 1, step 1: ONE small request to confirm this Cloudflare account/token can run the model on the free plan.
// Prints only safe facts (status, tokens, latency, answer, response SHAPE). Never prints the token or any reasoning text.
const fs = require('fs');
const { CloudflareAdapter, ModelError, CHOICES_FILE, loadChoices } = require('../src/adapters/cloudflare.js');
const { loadModelCfg } = require('../src/tulip.js');
const { Ledger, estimateNeurons } = require('../src/ledger.js');

(async () => {
  const cfg = loadModelCfg();
  console.log('Model:', cfg.model);
  console.log('CLOUDFLARE_ACCOUNT_ID set:', !!process.env.CLOUDFLARE_ACCOUNT_ID, '| CLOUDFLARE_API_TOKEN set:', !!process.env.CLOUDFLARE_API_TOKEN);
  const adapter = new CloudflareAdapter(cfg, { variant: 'none' });
  if (!adapter.hasCredentials()) {
    console.log('\nThe two environment variables are not visible in this terminal.');
    console.log('Set them as described in docs/setup.md, then open a NEW terminal window and run this again.');
    process.exit(2);
  }
  const ledger = new Ledger(cfg);
  const messages = [{ role: 'user', content: 'Reply with the single word: OK' }];
  console.log('\nSending 1 small request (max_tokens 200). Expected cost: well under 5 estimated Neurons.');
  let r, style = adapter.endpointStyle;
  const attempt = async () => adapter.complete({ messages, maxTokens: 200, variant: 'none' });
  try {
    try { r = await attempt(); }
    catch (e) {
      if (e instanceof ModelError && e.kind === 'not_found' && adapter.endpointStyle === 'openai') {
        console.log('OpenAI-compatible path returned 404; trying the native /ai/run path once (404 is not billed).');
        adapter.endpointStyle = 'run'; style = 'run'; r = await attempt();
      } else throw e;
    }
  } catch (e) {
    console.log('\nFAILED:', e.message);
    if (e.kind === 'auth') console.log('Hint: the token is missing, wrong, or lacks "Workers AI - Read" and "Workers AI - Edit" for this account; also check the Account ID.');
    if (e.kind === 'not_found') console.log('Hint: model or account not found. Check the Account ID and that the model name in config/model.json is current.');
    if (e.kind === 'daily_limit') console.log('Hint: the free daily allowance is used up. It resets at 00:00 UTC. Nothing is charged on the free plan.');
    process.exit(1);
  }
  const n = ledger.record(r.usage);
  console.log('\nRESULT');
  console.log('  endpoint style   :', style);
  console.log('  status           :', r.status, '| finish_reason:', r.finishReason);
  console.log('  latency          :', r.latencyMs, 'ms');
  console.log('  usage (reported) :', JSON.stringify(r.usage));
  console.log('  est. Neurons     : ~' + n.toFixed(3), '(ESTIMATE from reported tokens; dashboard is authoritative)');
  console.log('  answer           :', JSON.stringify(r.text));
  console.log('  reasoning signs  : field chars =', r.reasoning.field_chars, '| <think> tags =', r.reasoning.think_tags, '| unclosed =', r.reasoning.unclosed, '(contents never shown)');
  console.log('  response shape   :', JSON.stringify(r.shape));

  const ok = r.status === 'ok' || r.status === 'truncated';
  const choices = { ...loadChoices(), endpoint_style: style, access_verified: ok, access_verified_at: new Date().toISOString(), model: cfg.model };
  fs.writeFileSync(CHOICES_FILE, JSON.stringify(choices, null, 2) + '\n');
  console.log(ok ? '\nACCESS OK. Next: node scripts/probe_reasoning.js' : '\nThe call succeeded but returned no usable answer. Send me this output; do not retry in a loop.');
})();

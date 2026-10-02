'use strict';
// Terminal chat with Tulip. Usage: node src/cli.js [--verbose] [--mock]
const readline = require('readline');
const { createSession, BudgetError } = require('./tulip.js');
const G = require('./guards.js');
const { MockAdapter } = require('./adapters/mock.js');
const { Ledger } = require('./ledger.js');
const { loadModelCfg } = require('./tulip.js');

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const mock = args.has('--mock');

function wrap(text, width = 88) {
  return text.split('\n').map((line) => {
    const words = line.split(' '); const out = []; let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > width) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
    out.push(cur); return out.join('\n');
  }).join('\n');
}

let session;
const fresh = () => {
  session = createSession(mock ? { adapter: new MockAdapter([() => ({ text: 'This is a mock reply (no model was called).' })]), ledger: new Ledger(loadModelCfg(), { persist: false }) } : {});
  if (!mock && !session.adapter.hasCredentials()) {
    console.log('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set in this terminal. See docs/setup.md.');
    process.exit(2);
  }
  console.log('\nTulip: ' + G.FIXED.welcome + '\n');
};

console.log('Tulip terminal chat' + (mock ? ' [MOCK MODE: no model is used]' : '') + '. Commands: /new  /usage  /quit');
fresh();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });
rl.prompt();

async function handle(line) {
  const t = line.trim();
  if (!t) return rl.prompt();
  if (t === '/quit' || t === '/exit') return rl.close();
  if (t === '/new') { fresh(); return rl.prompt(); }
  if (t === '/usage') {
    const u = session.ledger.session;
    console.log('Session: ' + u.requests + ' requests, ' + u.input_tokens + ' input / ' + u.output_tokens + ' output tokens, ~' + u.est_neurons.toFixed(1) + ' estimated Neurons (ESTIMATE; Cloudflare dashboard is authoritative). Today (local ledger): ~' + session.ledger.todayEstimate().toFixed(1) + '.');
    return rl.prompt();
  }
  try {
    const { text, meta } = await session.ask(t);
    console.log('\nTulip: ' + wrap(text) + '\n');
    if (verbose) console.log('  [' + meta.path + ' | ' + meta.status + ' | ' + meta.latencyMs + ' ms | tokens ' + meta.usage.prompt_tokens + '/' + meta.usage.completion_tokens + ' | ~' + meta.est_neurons.toFixed(1) + ' Neurons est. | guards: ' + (meta.guards.join(',') || 'none') + (meta.error ? ' | ' + meta.error : '') + ']\n');
    if (verbose && meta.observations && meta.observations.length) console.log('  advisory notes (not applied to the answer): ' + meta.observations.map((o) => o.kind).join(', ') + '\n');
  } catch (e) {
    if (e instanceof BudgetError) console.log('\n[Stopped by local usage cap] ' + e.message + '\n');
    else console.log('\n[Error] ' + e.message + '\n');
  }
  rl.prompt();
}

// Lines are handled one at a time, in order (also when several lines are pasted at once).
let chain = Promise.resolve();
rl.on('line', (line) => { chain = chain.then(() => handle(line)); });
rl.on('close', () => { chain.then(() => { console.log('\nSession ended.'); process.exit(0); }); });

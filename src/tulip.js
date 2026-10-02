'use strict';
// Tulip for Node (CLI, tests, evaluation): loads the runtime files from disk and builds sessions.
const fs = require('fs');
const path = require('path');
const G = require('./guards.js');
const { loadRuntime } = require('./knowledge.js');
const { Ledger, BudgetError, estimateNeurons } = require('./ledger.js');
const { CloudflareAdapter } = require('./adapters/cloudflare.js');
const { ModelError } = require('./adapters/errors.js');
const { TulipSession } = require('./session_core.js');

const ROOT = path.resolve(__dirname, '..');
const loadModelCfg = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'model.json'), 'utf8'));

function createSession(opts = {}) {
  const modelCfg = opts.modelCfg || loadModelCfg();
  const knowledge = opts.knowledge || loadRuntime(G.CFG.runtime_flags);
  const adapter = opts.adapter || new CloudflareAdapter(modelCfg);
  const ledger = opts.ledger || new Ledger(modelCfg);
  return new TulipSession({ adapter, modelCfg, knowledge, ledger, runBudget: opts.runBudget || null, seedHistory: opts.seedHistory || null });
}

// Stateless entry point for a future server: history comes from the client and is treated as untrusted.
async function respond({ history, userMessage }, opts = {}) {
  const s = createSession({ ...opts, seedHistory: history });
  return s.ask(userMessage);
}

module.exports = { TulipSession, createSession, respond, loadModelCfg, BudgetError, ModelError, estimateNeurons };

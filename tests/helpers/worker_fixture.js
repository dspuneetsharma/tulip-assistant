'use strict';
// Copies the Worker sources into a temporary folder next to a bundle built from the EXAMPLE knowledge, then imports them there.
// Tests therefore never touch (or depend on) a private bundle in worker/generated/.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { exampleRuntime, tmp, ROOT } = require('./example_runtime.js');
const { write } = require('../../scripts/build_worker.js');

async function prepareWorker() {
  const { runtimeDir, knowledge } = exampleRuntime();
  const dir = tmp('assistant-worker-');
  fs.mkdirSync(path.join(dir, 'worker', 'generated'), { recursive: true });
  for (const f of ['app.mjs', 'ai_adapter.mjs', 'limits.mjs', 'usage_do.mjs', 'index.mjs']) fs.copyFileSync(path.join(ROOT, 'worker', f), path.join(dir, 'worker', f));
  write({ runtimeDir, outFile: path.join(dir, 'worker', 'generated', 'tulip_core.mjs') });
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  return { dir, knowledge, app: await imp('worker/app.mjs'), core: await imp('worker/generated/tulip_core.mjs'), adapter: await imp('worker/ai_adapter.mjs') };
}
module.exports = { prepareWorker };

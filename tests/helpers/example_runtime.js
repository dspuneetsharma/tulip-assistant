'use strict';
// Builds the invented example knowledge base into a temporary folder and loads it, so no test depends on anyone's private knowledge.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('../../scripts/build_runtime.js');
const { loadRuntime } = require('../../src/knowledge.js');
const G = require('../../src/guards.js');

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLE = path.join(ROOT, 'examples', 'knowledge_base', 'example_knowledge_base.md');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function exampleRuntime() {
  const runtimeDir = tmp('assistant-runtime-');
  build({ source: EXAMPLE, outDir: runtimeDir });
  return { runtimeDir, knowledge: loadRuntime(G.CFG.runtime_flags, { runtimeDir }) };
}
module.exports = { exampleRuntime, tmp, ROOT, EXAMPLE };

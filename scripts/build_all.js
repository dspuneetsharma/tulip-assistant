'use strict';
// What "wrangler deploy" runs first (see wrangler.jsonc): website files, then the Worker bundle.
const { renderSite } = require('./build_site.js');
const { write } = require('./build_worker.js');
const path = require('path');
renderSite(path.resolve(__dirname, '..', 'public'));
write();

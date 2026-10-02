# Testing

```bash
npm test
```

runs `tests/*.spec.js` with Node's built-in runner. All data is synthetic: the invented knowledge base in `examples/knowledge_base/` is built into a temporary folder for each run, and the Worker is tested through fake bindings (a scripted model, an in-memory SQLite database for the Durable Object, a fake static-assets binding). No network access, credentials or private files are used, and a private `worker/generated/` bundle is never read or written.

| Spec | Covers |
| --- | --- |
| `guards.spec.js` | Fixed-answer guards, pronoun and name handling, redaction, sentence tools, opt-in policies |
| `session.spec.js`, `knowledge.spec.js`, `adapters.spec.js` | Prompt assembly, history, retries, budgets, loader hash verification, adapter parsing and errors |
| `worker_api.spec.js` | HTTP routes, validation, limits, failures, headers, no leakage of knowledge |
| `worker_limits.spec.js` | Per-visitor and global limits, hashed IPs, purging, configuration defaults |
| `worker_bundle.spec.js` | Bundle equals the Node runtime, only allowlisted modules, tamper detection |
| `site.spec.js` | Rendered site audit (CSP compatibility, accessibility, text-only rendering, escaping) and `wrangler.jsonc` audit |
| `privacy.spec.js` | The scanner finds planted samples and finds nothing in the repository sources |

## Reviewing real answers

Automated tests cannot judge answer quality. Use `npm run eval` with your own cases and read the answers. Use `npm run dev:mock` to try the website locally against fake bindings.

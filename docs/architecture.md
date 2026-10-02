# Architecture

## Overview

```
visitor ─▶ website (static files)           site/ rendered to public/ at build time
   │
   └──▶ POST /api/chat ─▶ Worker (worker/app.mjs)
                            1. validate request (origin, size, JSON, history shape)
                            2. admit via Durable Object limiter (per-visitor + global budget)
                            3. TulipSession.ask()  ── deterministic guards ──▶ fixed answer, or
                                                  └─ model call (Workers AI binding) ─▶ output checks
                            4. settle measured Neurons, return { reply, history }
```

The same session code runs in Node (terminal client, tests, evaluation) and in the Worker. `scripts/build_worker.js` concatenates an allowlisted set of CommonJS modules plus your runtime knowledge into one ES module, `worker/generated/tulip_core.mjs`. That generated file contains your knowledge and is git-ignored.

## Components

| Component | Files | Role |
| --- | --- | --- |
| Session core | `src/session_core.js`, `src/tulip.js` | Builds the prompt, applies guards before and after the model, manages bounded history |
| Guards | `src/guards.js`, `src/sentences.js`, `config/guards.json` | Deterministic, config-driven rules and fixed texts (see [configuration](configuration.md)) |
| Observations | `src/observations.js` | Structural checks on answers (unsupported claims, leaked instructions, promises the application cannot keep) |
| Knowledge loader | `src/knowledge.js` | Reads only the files on the allowlist in `config/runtime_files.json`, verifies them against a hash manifest, fills the prompt template |
| Adapters | `src/adapters/` | Cloudflare REST adapter (terminal), mock adapter (tests), reasoning-text removal, error classification |
| Ledger | `src/ledger.js` | Estimates Neuron cost from reported token usage and enforces a local cap |
| Worker | `worker/` | HTTP API, Workers AI binding adapter, `UsageLimiter` Durable Object, `LimitStore` (pure logic, testable in Node) |
| Website | `site/`, `scripts/build_site.js` | Static page: plain HTML/CSS/JS, no external resources, answers rendered as text |

## Knowledge flow

`knowledge_base/knowledge_base.md` (yours, private) → `scripts/build_runtime.js` → `knowledge_base/runtime/{rules.md,facts.md,manifest.json}` → loader (hash-verified) → system prompt → (Worker build) embedded in the generated bundle.

The split between RULES and FACTS is lossless and purely structural (see [knowledge-base.md](knowledge-base.md)). Nothing outside the allowlisted files is ever read into the answering context.

## Request lifecycle details

- History is supplied by the client on each request, but is **sanitised**: only `user` and `assistant` roles are accepted, lengths and turn counts are bounded, and a client-supplied `system` message is rejected with HTTP 400.
- The limiter runs before the model and **fails closed**: if it is unavailable the request gets HTTP 503 and the model is not called.
- A Neuron reservation is made at admission and replaced by the measured figure after the call. If Cloudflare reports the free allocation exhausted, the day is marked exhausted and later requests are stopped without a model call.
- Model failures return a configured fallback text (HTTP 502) and do not extend history.

## Free-plan design

Static assets are served without invoking the Worker (`run_worker_first: ["/api/*"]`). The Durable Object is SQLite-backed (the only kind on the Free plan). Only admitted requests write rows, so a flood of rejected requests costs reads rather than writes.

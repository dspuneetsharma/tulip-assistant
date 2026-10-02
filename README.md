# tulip-assistant

A small, dependency-free toolkit for building a **personal AI representative**: an assistant that answers questions about one person (a recruiter or interviewer asks, the assistant replies in a professional, conversational voice) using **only a private knowledge base that you supply**.

This repository contains reusable code and technical documentation only. It contains **no personal knowledge**: the only sample data is an invented profile ("Alex Example") used for demos and tests. You bring your own knowledge base, keep it local, and build it into the runtime and the website yourself.

## What it does

- **Guarded question answering.** A system prompt template plus deterministic guards (finance privacy, scope, unclear questions, message-forwarding honesty, prompt-injection resistance, withheld terms, unsupported-claim checks) wrap a language model so answers stay inside what the knowledge base records.
- **Terminal client** (`npm run chat`) and **website + API** that run on the Cloudflare **Free** plan: static assets, a Worker, the Workers AI binding and a SQLite-backed Durable Object for rate limits. No API token is used by the deployed site.
- **Usage protection.** Per-visitor limits (hashed IP), a global daily Neuron budget and request cap, fail-closed behaviour, same-origin only, strict Content-Security-Policy.
- **Privacy tooling.** A scanner and pre-commit hook that block personal-looking data from being committed.
- **Hermetic tests.** 100+ tests run on synthetic data with fake bindings; no network or credentials.

## Quick start (no credentials, invented data)

Requires Node.js 22 or newer. There are no runtime dependencies to install.

```bash
npm test               # run the test suite against the invented example knowledge base
npm run demo           # build the example knowledge and chat with a scripted stand-in model
npm run dev:mock       # serve the website locally with fake bindings (prints the URL)
```

## Use your own knowledge base

1. Copy `examples/knowledge_base/example_knowledge_base.md` to `knowledge_base/knowledge_base.md` (this folder is git-ignored) and replace its content with your own. See [docs/knowledge-base.md](docs/knowledge-base.md) for the required structure.
2. Set the assistant's name, your name, your public contact email and the fixed wording in `config/guards.json` (see [docs/configuration.md](docs/configuration.md)).
3. Build the runtime files: `npm run build` (verifies the structure and writes git-ignored files to `knowledge_base/runtime/`).
4. Chat locally: `npm run chat` (needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set in your terminal; see [docs/setup.md](docs/setup.md)) or `npm run chat:mock` (no model).
5. Review answers with your own cases: put them in `evaluations/` (git-ignored; format in `examples/evaluation/example_cases.json`) and run `npm run eval`.
6. Deploy: [docs/deployment.md](docs/deployment.md).

Your knowledge base, the generated runtime files, the generated Worker bundle (`worker/generated/`) and the rendered site (`public/`) all contain your personal information and are **git-ignored by design**. Do not remove those rules.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | Core session logic, guards, sentence tools, ledger, model adapters, terminal client |
| `worker/` | Cloudflare Worker: API routes, Workers AI adapter, limiter Durable Object |
| `site/` | Website templates (tokens such as `{{assistant}}` are filled at build time) |
| `config/` | `guards.json` (identity, policies, fixed texts), `model.json`, runtime-file allowlist |
| `prompts/` | System prompt template |
| `scripts/` | Build, check, evaluation, deployment-verification and privacy scripts |
| `examples/` | Invented knowledge base and review cases |
| `tests/` | Synthetic-data tests and helpers |
| `docs/` | Technical documentation |

## Documentation

- [Architecture](docs/architecture.md)
- [Setup](docs/setup.md)
- [Knowledge base format](docs/knowledge-base.md)
- [Configuration and customisation](docs/configuration.md)
- [Deployment on Cloudflare (Free plan)](docs/deployment.md)
- [Security and privacy](docs/security-and-privacy.md)
- [Testing](docs/testing.md)

## Before you publish your own fork

Run `npm run check:private`, and create a `.private-denylist.txt` (git-ignored) with one case-insensitive regular expression per line for your own name, employer, phone number and so on; the scanner then also flags those. Enable the hook once per clone: `git config core.hooksPath .githooks`.

## Licence

No licence file is included. All rights are reserved by the repository owner until one is added.

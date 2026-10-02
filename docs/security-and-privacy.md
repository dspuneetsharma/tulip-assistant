# Security and privacy

## What stays private

These are git-ignored and must never be committed (`.gitignore` and the pre-commit hook enforce this):

- `knowledge_base/` (your knowledge base and the generated runtime files)
- `worker/generated/` (bundle containing your knowledge) and `public/` (rendered site)
- `evaluations/`, `logs/`, `reports/`, `checkpoints/`, `messages/`, `experiments/`
- `.env*` (except `.env.example`), `.dev.vars*`, keys, tokens, `config/local_choices.json`, `.private-denylist.txt`

## Scanner and hook

`node scripts/check_private_data.js` flags non-example email addresses, phone numbers, 32-hex identifiers, real `workers.dev` addresses, token-like strings and Windows user paths, and refuses forbidden paths. With `--denylist FILE` (or a git-ignored `.private-denylist.txt`) it also flags your own terms. Matches are reported as `file:line` and rule name, without printing the matched text. `git config core.hooksPath .githooks` runs it on staged files before each commit. A scanner cannot prove a repository is free of personal information: review `git ls-files` and `git diff --cached` yourself.

## Runtime protections

- Same-origin only, JSON only, request and history size limits, no client-supplied system messages.
- Visitor text is treated as data; instructions to change rules or reveal facts are ignored by the prompt and checked by guards.
- Model reasoning text is removed and never returned or logged.
- Errors return generic messages; no stack traces or internals.
- Raw IP addresses are not stored: a salted hash is used for rate limiting and old rows are purged.
- Responses carry `no-store` and security headers; the page has a strict CSP without inline code.
- The limiter fails closed.

## Credentials

Never put tokens in code, browser assets, `wrangler.jsonc`, tests or logs. The deployed Worker uses a binding. Terminal scripts read `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment and redact them from error text. If a token is exposed, revoke it in the Cloudflare dashboard.

## Reporting

Contact the repository owner directly rather than opening a public issue with sensitive details.

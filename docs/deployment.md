# Deployment on Cloudflare (Free plan)

This describes what the repository supports. Nothing here is deployed by default.

## Prerequisites

- A Cloudflare account on the Free plan with Workers AI available.
- Your private knowledge base built (`npm run build`) and `config/guards.json` edited.
- `npm test` passing.

## Authenticate without tokens in files

```bash
npx wrangler@latest login        # opens a browser; the credential stays in Wrangler's own store
npx wrangler@latest whoami       # confirm the account
```

The deployed site uses the Workers AI **binding**; it needs no API token, and none is placed in browser code or in the repository.

## Deploy

```bash
npm run deploy
```

This runs `scripts/build_all.js` (renders `site/` to `public/`, rebuilds `worker/generated/tulip_core.mjs` from your verified runtime knowledge) and then `wrangler deploy`. The worker name comes from `wrangler.jsonc` (`tulip-assistant`); change it if you need a different address (`https://<name>.<your-subdomain>.workers.dev`).

The first deployment applies the `UsageLimiter` Durable Object migration (SQLite-backed, Free plan compatible).

## Verify

```bash
node scripts/verify_deployment.js https://<name>.<your-subdomain>.workers.dev
```

It uses no credentials, sends a few real chat requests (each costs roughly 60–75 Neurons) and writes `logs/deployment_verification.json` (git-ignored). Read the answers yourself; do not rely on the checks alone. Keep the deployed URL, account identifiers and logs out of the repository.

## Updating knowledge

Edit `knowledge_base/knowledge_base.md`, run `npm run build`, `npm test`, `npm run eval`, then `npm run deploy`.

## Cost and limits

Neuron figures are estimates; confirm usage in the Cloudflare dashboard. When the daily allocation is reached the site returns a clear usage-limit message until the next UTC day.

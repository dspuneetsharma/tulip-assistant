# Setup

## Requirements

- Node.js 22 or newer (`package.json` declares `engines.node >=22`; the Worker tests use `node:sqlite`).
- Git.
- For the live terminal client and scripts that call the model over REST: a Cloudflare account with Workers AI available on the Free plan.
- For deployment: Wrangler (`npx wrangler@latest`, no global install needed).

There are no runtime or development npm dependencies.

## 1. Try it with invented data

```bash
npm test
npm run demo
```

`npm run demo` builds the example knowledge base into `knowledge_base/runtime/` (git-ignored) and starts the terminal client with a scripted stand-in model, so no network or credentials are involved.

## 2. Supply your own private knowledge base

```bash
mkdir -p knowledge_base
cp examples/knowledge_base/example_knowledge_base.md knowledge_base/knowledge_base.md
# edit knowledge_base/knowledge_base.md: replace every invented detail with your own
npm run build
```

`knowledge_base/` is git-ignored. Keep any other private inputs (CV exports, notes, evaluation transcripts, reports, logs) in git-ignored folders too: `evaluations/`, `logs/`, `reports/`, `checkpoints/`, `messages/`, or outside the repository.

Edit `config/guards.json` for your name, assistant name, public contact email and fixed wording ([configuration.md](configuration.md)). Placeholders in the prompt and fixed texts are filled from that file.

## 3. Talk to the model from the terminal (optional)

Create a Cloudflare API token that can run Workers AI, then set two environment variables **in your terminal session** (never in a file that is committed):

```powershell
# PowerShell
$env:CLOUDFLARE_ACCOUNT_ID = "<your account id>"
$env:CLOUDFLARE_API_TOKEN  = "<your token>"
```
```bash
# bash
export CLOUDFLARE_ACCOUNT_ID="<your account id>"
export CLOUDFLARE_API_TOKEN="<your token>"
```

Then:

```bash
npm run check    # one small request: confirms the account, token and model work (prints no secrets)
npm run chat     # interactive terminal chat; add --verbose for guard and cost details
```

`.env.example` shows the variable names only. Do not create a committed `.env`.

`npm run probe` tests how the model handles hidden reasoning text and may write `config/local_choices.json` (git-ignored). The default is the `/no_think` switch for Qwen3 models.

## 4. Evaluate

`npm run eval:mock` checks the structure with a scripted model. `npm run eval` sends the cases to the live model with a Neuron budget (`--budget`, default 2400). Put your own case files in `evaluations/` and select one with `--set`. Automatic checks only flag clear failures; read the answers yourself.

## 5. Deploy

See [deployment.md](deployment.md).

# Configuration and customisation

## `config/guards.json`

| Key | Meaning |
| --- | --- |
| `identity.assistant_name` | Name the assistant uses for itself (`{{assistant}}`) |
| `identity.owner_reference` | How the assistant refers to the person it represents (`{{owner}}`) |
| `identity.owner_aliases` | Other names or short forms recognised in questions and answers |
| `public_contact.email` | Public email shown on the site and in fixed texts (`{{email}}`) |
| `runtime_flags` | `message_saving` and `external_delivery`. Both are `false`: the assistant must never claim it can save or forward a message. Only set `true` after you have implemented that capability |
| `blocked_terms` | Terms that must never appear in answers (replaced by `redaction_token`); the runtime build also reports them if they occur in your knowledge base |
| `fixed_text.*` | Wording for deterministic replies. May contain `{{owner}}`, `{{assistant}}`, `{{email}}` |
| `policies.*` | Opt-in behaviours, all `false` by default (below) |

### Opt-in policies

- `ai_coding_disclosure`: when `true`, named AI coding tools are redacted from answers, and questions about who wrote the code are answered from the `authored_authorship_*` texts. Only enable it if it matches what your knowledge base states.
- `refer_to_owner_by_name`: when `true`, "he"/"him" in answers is replaced by the owner's name (sentences that already name the owner keep their pronoun).
- `pronoun_exclusion_names`: names (for example of other people in projects) exempt from that normalisation.

## `config/model.json`

Model identifier, token budgets, retry behaviour, history limits (turns and character bounds) and Neuron pricing used for local estimates. The Neuron figures are **estimates**; the Cloudflare dashboard is authoritative. Changing the model may require re-running `npm run probe` and re-reading answers with `npm run eval`.

## `prompts/system_prompt.md`

The system prompt template. Only `{{assistant}}` and `{{owner}}` are substituted. If you edit it, keep the "answer from FACTS only" and "never invent" rules; the tests assert several of them.

## Website

`site/` holds the templates. `{{assistant}}`, `{{owner}}`, `{{email}}` and `{{welcome}}` are filled and escaped by `scripts/build_site.js`. The page uses no inline script or style and no external resources, so the strict CSP in `site/_headers` applies. Keep it that way when customising.

## Limits

`wrangler.jsonc` `vars` and `worker/limits.mjs` hold the defaults: 6 requests per minute, 40 per hour and 120 per day per visitor, a global 8,000-Neuron daily budget (below the 10,000 free allocation) and 400 requests per day. A test asserts that the two sources agree.

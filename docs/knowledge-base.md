# Knowledge base format

You write one Markdown file, `knowledge_base/knowledge_base.md`, with numbered `##` sections. The build script splits it:

| Part | Sections | Used as |
| --- | --- | --- |
| RULES | everything before `## 3.` and everything from `## 12.` onward | Behaviour, identity, scope, privacy and wording guidance for the assistant |
| FACTS | `## 3.` up to (not including) `## 12.` | The only source of facts about you |

The split is lossless: the two parts are exact substrings of your file.

`examples/knowledge_base/example_knowledge_base.md` is a complete, invented template. Suggested contents:

- **Sections 1–2 (rules):** how evidence is classified, assistant identity and behaviour, scope, handling of unknown details, financial privacy, messages and contact, questions the assistant may ask recruiters.
- **Sections 3–11 (facts):** profile and education, motivations and preferences, ownership and use of tools, professional experience, one section per project (problem, data, method, your contribution, results, limits), research, earlier projects, skills with evidence boundaries.
- **Sections 12–13 (rules):** details you do not want to provide and short answer patterns.

Guidelines that make the answers better:

1. Record **what was done, what was observed and what was only intended** as separate statements. The assistant is instructed not to turn intentions into results.
2. State **limits** explicitly (offline only, single run, prototype). They are passed to the model as facts.
3. State **reasons** only where you have them; when a reason is not written down, the assistant will say it is not recorded.
4. Do not put financial figures, ID numbers, credentials or details you do not want a recruiter to see in the file. `npm run build` prints audit findings (and records them in the manifest) for financial-looking figures, pay terms, administrative markers and any term listed in `blocked_terms` in `config/guards.json`. Review them; the build still completes.
5. Keep personal facts here and nowhere else in the repository. Code, prompt and tests must stay generic.

## Build output

`npm run build` writes `knowledge_base/runtime/rules.md`, `facts.md` and `manifest.json` (SHA-256 hashes). At load time the hashes are verified, so an edited runtime file that was not produced by the build script is rejected. Rebuild after every edit.

'use strict';
// Advisory observations on a finished answer. Logging only: nothing here edits, rejects or regenerates an answer, and the
// application never calls it to decide what the visitor sees. It exists so that a human reviewing live answers (and the evaluation
// script) can see at a glance where to look. These are prompts for review, not verdicts.
const { splitSentences, isFragment } = require('./sentences.js');
const G = require('./guards.js');
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER_RE = new RegExp(G.ownerPattern(G.OWNER) + "(?![’'])", 'g');
const EMAIL_RE = new RegExp(esc(G.CFG.public_contact.email), 'g');

// Default facts are read lazily (Node only). The Worker and the session pass the facts in explicitly.
let FACTS_CACHE = null;
const defaultFacts = () => { if (FACTS_CACHE === null) { try { FACTS_CACHE = require('fs').readFileSync(require('path').join(__dirname, '..', 'knowledge_base', 'runtime', 'facts.md'), 'utf8'); } catch (e) { FACTS_CACHE = ''; } } return FACTS_CACHE; };
const digitsOf = (s) => (String(s).replace(/\b[A-Za-z]+_\d+\w*/g, ' ').match(/\d[\d.,]*\d|\d/g) || []).map((x) => x.replace(/[.,]+$/, ''));

// Numbers in the answer that appear neither in the approved facts nor in the visitor's question.
function unrecordedNumbers(answer, question, facts) {
  const f = String(facts == null ? defaultFacts() : facts).replace(/,/g, ''); const q = String(question || '').replace(/,/g, '');
  return [...new Set(digitsOf(answer))].filter((n) => !/^[1-9]$/.test(n) && !f.includes(n.replace(/,/g, '')) && !q.includes(n.replace(/,/g, '')));
}

function observe(answer, ctx) {
  const c = ctx || {}; const a = String(answer || ''); const out = [];
  const add = (kind, note) => out.push({ kind, note });
  const nums = unrecordedNumbers(a, c.question, c.facts); if (nums.length) add('numbers_not_in_facts', 'check against the facts: ' + nums.join(', '));
  if (/\b(?:helped|help|helps)\s+(?:to\s+)?(?:improve|enhance|boost|ensure)|\b(?:led|leading)\s+to\b|\bresulted\s+in\b|\bensur(?:ed|es|ing)\b|\bguarantee/i.test(a)) add('causal_wording', 'a cause or outcome is stated: check that the facts attribute it to that step');
  if (/\b(?:did not|didn['’]t|never)\s+(?:actually\s+)?(?:use|used|work with|rely on)\b/i.test(a)) add('non_use_wording', 'a denial of use: missing evidence is not proof of non-use');
  if (/\b(?:available|provided|given|supplied) (?:information|facts|context|records?|details|documentation)\b|\b(?:in|from) (?:the|his) (?:profile|records?|documentation)\b|\bas (?:documented|stated|recorded) in\b|\baccording to (?:the )?(?:facts|record|documentation)\b/i.test(a)) add('source_wording', 'refers to its source material');
  if (/\b(?:chose|chosen|selected|picked|opted for|preferred)\b[^.?!]{0,80}\b(?:for|because|due to|owing to|as)\b|\b(?:the reason|reasons|rationale)\b|\bbased on the need\b/i.test(a)) add('reason_stated', 'a reason for a choice is stated: check that the facts record it');
  if (/\b(?:regularly|daily|day-to-day|frequently|often|routinely|extensively|as needed|each being used|heavily)\b/i.test(a)) add('frequency_wording', 'how often something is used: check that the facts record it');
  if (/\b(?:demonstrates?|demonstrated|shows?|showed|proves?|proven)\b[^.?!]{0,60}\b(?:ability|capable|capability|skills?|expertise|proficien\w*|experience)\b|\b(?:valuable|strong|extensive|deep) (?:skills?|experience|expertise)\b/i.test(a)) add('capability_claim', 'a capability or expertise is claimed: check that the facts say it');
  if (/\b(?:significantly|statistically|substantially|dramatically)\b/i.test(a)) add('magnitude_wording', 'strength wording: check against the facts');
  if (/\b(?:he|him)\b(?!['’])/i.test(a)) add('pronoun', 'he/him used for ' + G.OWNER);
  const names = (a.replace(EMAIL_RE, '').match(OWNER_RE) || []).length; if (names > 3) add('name_frequency', G.OWNER + ' named ' + names + ' times');
  if (a.length > 1000) add('long', a.length + ' characters');
  const frag = splitSentences(a).filter((sn) => sn.trim().split(/\s+/).length >= 3 && isFragment(sn)); if (frag.length) add('fragment', 'possible fragment: ' + frag[0].slice(0, 80));
  const email = new RegExp(esc(G.CFG.public_contact.email)).test(a); const gap = /hasn['’]t been (?:provided|confirmed|recorded)|\bnot (?:been )?(?:confirmed|recorded|provided|documented)\b|\bunconfirmed\b/i.test(a);
  if (gap && !email) add('limitation_without_contact', 'a limitation is stated and no contact is offered');
  if (email && !gap && !/withheld/i.test(a)) add('contact_without_limitation', 'contact offered but no missing detail is stated');
  if ((a.match(EMAIL_RE) || []).length > 1) add('contact_repeated', 'the email appears more than once');
  return out;
}
module.exports = { observe, unrecordedNumbers };

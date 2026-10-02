'use strict';
// Deterministic guards for Tulip. Pure functions, no network, no model calls.
//
// Design (simplified): the model answers from the approved facts and rules in the system prompt. This file keeps only
//   * input boundaries that must hold before the model is called (personal finances, message requests, farewell, introductions,
//     the withheld source title, AI product names), and
//   * output boundaries for clear failures (a financial figure, the withheld title, a false claim that a message was saved or
//     sent, a false statement about coding assistance, leaked internal instructions) and broken output (markdown, stray greeting).
// It does NOT judge wording, causes, reasons, tone, length or name frequency, and it does not rewrite answers sentence by
// sentence. Fixed/approved sentences come from config/guards.json.

const RAW = require('../config/guards.json'); // a JSON require, so the same file bundles into the Worker
const { splitSentences, noTitle } = require('./sentences.js');

// ---------- Identity and policies (config/guards.json) ----------
// {{owner}}, {{assistant}} and {{email}} in the configured texts are filled once, when this module loads.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ID = RAW.identity;
const OWNER = ID.owner_reference;
const ASSISTANT = ID.assistant_name;
const fillText = (s) => s.split('{{owner}}').join(OWNER).split('{{assistant}}').join(ASSISTANT).split('{{email}}').join(RAW.public_contact.email);
const deepFill = (v) => (typeof v === 'string' ? fillText(v) : Array.isArray(v) ? v.map(deepFill) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFill(x)])) : v);
const CFG = deepFill(RAW);
const FIXED = CFG.fixed_text;
const EMAIL = CFG.public_contact.email;
// Regex source for the owner's name; a title dot ("Dr.") is optional so it also matches after noTitle().
function ownerPattern(ref) {
  const words = String(ref).trim().split(/\s+/);
  return words.map((w, i) => { const dot = w.endsWith('.'); return escapeRe(dot ? w.slice(0, -1) : w) + (dot ? '\\.?' : '') + (i < words.length - 1 ? (dot ? '\\s*' : '\\s+') : ''); }).join('');
}
const OWNER_P = ownerPattern(OWNER);
const ALIAS_P = (ID.owner_aliases || []).map(escapeRe);
const POLICY = () => CFG.policies || {};
const aiDisclosure = () => !!POLICY().ai_coding_disclosure;
const FINANCE_PLACEHOLDER = '[question about ' + OWNER + "'s personal finances]";

// ---------- Personal-finance guard (input side) ----------
// Goal: protect the owner's personal finances; still allow machine learning in finance and finance-related project questions.

// Terms that are personal-finance words on their own.
const HARD_FINANCE = /\b(ctc|c\.t\.c|lpa|salary|salaries|remuneration|compensation|take[- ]?home|in[- ]?hand|stipend|pay ?slips?|net worth|bank (?:balance|account|statement)|credit score)\b/i;
// Amounts written as money.
const AMOUNT_IN_TEXT = /(\b\d+(?:[.,]\d+)?\s*(?:lpa|lakhs?|lacs?|crores?)\b|(?:₹|\brs\.?|\binr\b|\busd\b)\s?\d|\$\s?\d)/i;
// "how much does he earn / was he paid / does he charge ..."
const HOW_MUCH_EARN = /\bhow much\b[^.?!]{0,80}\b(earn\w*|paid|pay|charge|receiv\w*|drawing|compensat\w*)\b/i;
// pay he hopes for / expects: "monthly pay he is hoping for", "what pay is he looking for", "what is he asking for in wages"
const PAY_EXPECTATION = /\b(?:monthly|annual|yearly|weekly|hourly|base|fixed)\s+(?:pay|income|earnings?|wages?)\b|\b(?:pay|wages?|remuneration|package)\b[^.?!]{0,40}\b(?:hoping|expecting|expects?|looking|asking|wants?|wanting|aiming|seeking|negotiat\w*)\b|\b(?:hoping|expecting|looking|asking|seeking|aiming)\s+for\b[^.?!]{0,25}\b(?:pay|wages?|money|package|remuneration)\b/i;
const EXPECTED_PAY = /\b(?:current|last|previous|present|expected|desired|target|existing|drawn)\s+(?:package|pay|income|earnings?)\b/i;
const WHAT_EARN = new RegExp('\\bwhat\\b[^.?!]{0,30}\\b(?:does|did|do|is|was)\\b[^.?!]{0,20}\\b(?:he|she|they|' + OWNER_P + (ALIAS_P.length ? '|' + ALIAS_P.join('|') : '') + '|you)\\b[^.?!]{0,20}\\b(?:earn\\w*|paid|make|making|get paid)\\b', 'i');
// Possessive personal-finance nouns. "Strong" ones always block; "weak" ones can be topical (loan-default models etc.).
const POSSESSOR = "(?:his|her|their|your|" + OWNER_P + "'?s?" + ALIAS_P.map((a) => "|" + a + "'?s?").join("") + ")";
const MODS = "(?:(?:own|personal|current|total|monthly|annual|yearly)\\s+)*";
const STRONG_SOFT = new RegExp("\\b" + POSSESSOR + "\\s+" + MODS + "(?:income|savings?|net worth|debts?|bank|wealth|finances|financial\\s+(?:situation|status|details|information|history|position|condition))\\b", 'i');
const WEAK_SOFT = new RegExp("\\b" + POSSESSOR + "\\s+" + MODS + "(?:loans?|investments?|profits?|earnings|money|funds|capital|assets|expenses|rent|mortgage)\\b(?!\\s+(?:default|prediction|predict|approval|model|models|risk|scoring|dataset|data|project|analysis|classification|forecast\\w*))", 'i');
const OWN_MONEY = /\b(?:his|your)\s+own\s+(?:money|funds|capital)\b/i;
const FINANCE_TOPIC = /\b(stock|stocks|market|trading|fintech|finance|financial\s+(?:data|model\w*|analysis|forecast\w*|domain|application\w*|project\w*)|forecast\w*|portfolio optimi[sz]ation|credit risk|fraud)\b/i;

function isPersonalFinanceQuestion(text) {
  const t = String(text || '');
  if (HARD_FINANCE.test(t) || AMOUNT_IN_TEXT.test(t) || HOW_MUCH_EARN.test(t) || EXPECTED_PAY.test(t) || WHAT_EARN.test(t) || PAY_EXPECTATION.test(t)) return true;
  if (STRONG_SOFT.test(t) || OWN_MONEY.test(t)) return true;
  if (WEAK_SOFT.test(t) && !FINANCE_TOPIC.test(t)) return true;
  return false;
}

// ---------- Personal-finance guard (output side) ----------
const OUT_AMOUNT = /(\b\d[\d,.]*\s*(?:lpa|lakhs?|lacs?|crores?)\b|(?:₹|\brs\.?|\binr\b|\busd\b)\s?\d|\$\s?\d|\b(?:six|seven|eight)[- ]figure\b)/i;
const OUT_PAYTERM_NUMBER = /\b(ctc|salary|compensation|remuneration|stipend|take[- ]?home)\b[^.\n]{0,60}\d/i;
function outputLeaksFinance(text) {
  const t = String(text || '');
  return OUT_AMOUNT.test(t) || OUT_PAYTERM_NUMBER.test(t);
}

// ---------- Withheld-terms guard ----------
// config blocked_terms lists words that must never reach the model or a visitor (for example the title of a private source). Empty by default.
let termsKey = null; let termsRe = null; let termsReG = null;
function termRegexes() {
  const terms = (CFG.blocked_terms || []).filter(Boolean);
  const key = terms.join('|');
  if (key !== termsKey) {
    termsKey = key;
    if (terms.length) { const alt = terms.map(escapeRe).join('|'); termsRe = new RegExp('(' + alt + ')', 'i'); termsReG = new RegExp('(\\w*(?:' + alt + ')\\w*)', 'ig'); }
    else { termsRe = null; termsReG = null; }
  }
  return { re: termsRe, reG: termsReG };
}
function containsSourceTerm(text) { const { re } = termRegexes(); return !!re && re.test(String(text || '')); }
function redactSourceTerms(text) {
  const s = String(text || '');
  const { reG } = termRegexes();
  if (!reG) return { text: s, redacted: false };
  const tok = CFG.redaction_token;
  let out = s.replace(reG, tok);
  // collapse a title that spans several matched words into one placeholder
  const dbl = new RegExp('(?:' + escapeRe(tok) + '\\s+)+' + escapeRe(tok), 'g');
  out = out.replace(dbl, tok);
  return { text: out, redacted: out !== s };
}


// ---------- AI product names (input and output) ----------
// The approved facts establish that coding assistance was used under the owner's direction, not which tool. A visitor's tool name is
// replaced by a neutral placeholder before the model sees it (so the model cannot confirm, deny or repeat it), and the same
// list is used to remove a product name the model volunteers.
const ASSISTANT_TOOL_NAMES = 'claude|chatgpt|gpt-?\\d[\\w.-]*|gpt|openai|copilot|gemini|cursor|codex|anthropic|bard|windsurf';
const ASSISTANT_TOOL_RE = new RegExp('\\b(?:' + ASSISTANT_TOOL_NAMES + ')\\b', 'i');
const ASSISTANT_TOOL_RE_G = new RegExp('\\b(?:' + ASSISTANT_TOOL_NAMES + ')\\b', 'ig');
const TOOL_PLACEHOLDER = '[a named AI tool]';
function redactAssistantTools(text) {
  const s = String(text || '');
  if (!aiDisclosure()) return { text: s, redacted: false };
  const out = s.replace(ASSISTANT_TOOL_RE_G, TOOL_PLACEHOLDER);
  return { text: out, redacted: out !== s };
}
function mentionsAssistantTool(text) { return aiDisclosure() && ASSISTANT_TOOL_RE.test(String(text || '')); }

// ---------- Clear failures in a generated answer ----------
// False statements about coding assistance (only active when config policies.ai_coding_disclosure is true: the configured position is that
// AI coding assistance handled the implementation under the owner's direction). Narrow patterns: a denial of assistance, or a claim that
// the owner personally wrote all the code.
const CODE_HELP = '(?:ai|artificial intelligence|llm|coding assistance|coding assistant|code assistance|code assistant|assistant|assistance|ai tools?|coding tools?)';
const CODE_OBJECT = '(?:code|codebase|source code|scripts?|programs?|software|pipeline|implementation|notebooks?)';
const AUTHORSHIP_FALSE = [
  new RegExp('\\b(?:no|without any|without|had no|with no)\\s+(?:any\\s+)?' + CODE_HELP + '\\b', 'i'),
  new RegExp('\\b(?:did not|didn[\'’]t|does not|doesn[\'’]t|never)\\s+(?:use|used|rely on|receive|get|have)\\s+(?:any\\s+)?(?:help from\\s+)?(?:an?\\s+)?' + CODE_HELP + '\\b', 'i'),
  /\bnot\s+(?:written|coded|implemented|generated|built|produced|created)\s+by\s+(?:an?\s+)?(?:ai|assistant|coding assistant|llm)\b/i,
  /\b(?:the\s+)?(?:code|implementation)\s+(?:was|were)\s+(?:not|never)\s+(?:written|generated|produced|done)\s+(?:by|with|using)\s+(?:an?\s+)?(?:ai|assistant|coding assistant|llm)\b/i,
  new RegExp('\\b' + OWNER_P + '\\s+(?:has\\s+|had\\s+)?(?:personally\\s+|himself\\s+|herself\\s+|themselves?\\s+|independently\\s+|alone\\s+)?(?:coded|programmed|hand-?wrote|hand-?coded)\\b', 'i'),
  new RegExp('\\b' + OWNER_P + '\\s+(?:has\\s+|had\\s+)?(?:personally\\s+|himself\\s+|herself\\s+|themselves?\\s+|independently\\s+|alone\\s+)?(?:wrote|written|implemented)\\b[^.]{0,60}\\b' + CODE_OBJECT + '\\b', 'i'),
  new RegExp('\\b(?:wrote|written|coded|programmed|implemented)\\b[^.]{0,40}\\b(?:all|every|the entire|the whole|each)\\b[^.]{0,25}\\b(?:code|lines?|implementation|pipeline)\\b', 'i'),
  { all: [/\b(?:by (?:himself|herself|themselves)|on (?:his|her|their) own|all (?:himself|herself)|entirely (?:himself|herself)|single-?handed(?:ly)?)\b/i, /\b(?:code|coding|coded|programm\w+|implement\w*|codebase|scripts?|software)\b/i] },
];
const NEG_BEFORE = /\b(?:not|never|no|n['’]t|rather than|instead of|without)\b[^.]{0,40}$/i;
function falseAuthorship(sentence) {
  if (!aiDisclosure()) return false;   // opt-in policy: config policies.ai_coding_disclosure
  const t = noTitle(sentence);
  for (const re of AUTHORSHIP_FALSE) {
    if (re.all) { if (re.all.every((x) => x.test(t))) return true; continue; }
    const m = t.match(re);
    if (!m) continue;
    // "the owner did not write the code" is the honest direction; only a positive personal-coding claim is a failure
    const isDenialOfHelp = /\b(?:no|without|did not|didn['’]t|does not|doesn['’]t|never|not\s+(?:written|coded|implemented|generated|built|produced|created)|was not|were not)\b/i.test(m[0]) && /help|assist|\bai\b|llm|assistant/i.test(m[0]);
    if (isDenialOfHelp) return true;
    if (!NEG_BEFORE.test(t.slice(0, m.index))) return true;
  }
  return false;
}

// Leaked internal material: the reference blocks, the system prompt or application notes. (Wording like "the available information" is
// only advisory, see src/observations.js.)
const INTERNAL_LEAK = /\bFACTS\b|\bRULES\b|\b(?:system prompt|application note|internal directions?)\b|\bmy (?:instructions|rules|guidelines|knowledge base)\b|\bEVIDENCE\s*\(/;
function leaksInternals(sentence) { return INTERNAL_LEAK.test(String(sentence || '')); }

// ---------- Contact offer (existing policy, written by the model; the application only keeps it true and single) ----------
const INQUIRY_OFFER = /\b(?:leave|send|submit)\s+(?:me\s+)?(?:a|an|your)\s+(?:message|inquiry|enquiry|note)\b|\b(?:would you like|shall|should|can|could|may) (?:me|i)\s+(?:to\s+)?(?:forward|pass|relay|take|save|record|send|submit|note)\b[^.?!]*\b(?:message|question|inquiry|enquiry|request|details|note)\b|\bI(?:'ll| will)\s+(?:forward|pass|relay|take|save|record|send|submit|note)\b[^.?!]*\b(?:message|question|inquiry|enquiry|request|details|note)\b/i;
const UNKNOWN_SENTENCE = new RegExp('That detail hasn[\'’]t been provided by ' + OWNER_P + '|\\bI (?:don[\'’]t|do not) have (?:any )?information on that', 'i');
const OFF_TOPIC_TOKEN = /\[\s*OFF[_ -]?TOPIC\s*\]/i;
const contactTail = (flags) => (flags && flags.message_saving ? FIXED.authored_contact_with_messaging : FIXED.authored_contact_no_messaging);
// While messaging is unavailable an offer to take a message is not true; it is replaced by the true next step (the public email).
function fixInquiryOffers(text, flags) {
  if (flags && flags.message_saving) return { text, changed: false };
  const sents = splitSentences(text);
  if (!sents.some((sn) => INQUIRY_OFFER.test(sn))) return { text, changed: false };
  const kept = sents.filter((sn) => !INQUIRY_OFFER.test(sn));
  let out = kept.join(' ').trim();
  if (!out.includes(EMAIL)) out = (out + ' ' + contactTail(flags)).trim();
  return { text: out || FIXED.authored_message_request_no_messaging, changed: true };
}
// The public email is offered once per answer.
function dedupeContact(text) {
  const sents = splitSentences(text); let seen = false; let changed = false;
  const out = sents.filter((sn) => {
    if (!sn.includes(EMAIL)) return true;
    if (!seen) { seen = true; return true; }
    changed = true; return false;
  });
  return { text: changed ? out.join(' ') : text, changed };
}
// A model that has been told it cannot take messages still sometimes writes the old approved question next to the unknown-detail sentence.
function stripInquiryOffers(text) {
  const kept = splitSentences(text).filter((sn) => !INQUIRY_OFFER.test(sn));
  return kept.join(' ').trim();
}

// Optional policy (config policies.refer_to_owner_by_name): visitors read the owner's name rather than "he"/"him". A sentence that
// already names the owner keeps its natural pronoun, so the name is not stacked up inside one sentence. Answers that mention a person
// listed in policies.pronoun_exclusion_names are left alone, so other people are never relabelled. Off by default.
function normalisePronouns(text) {
  if (!POLICY().refer_to_owner_by_name) return text;
  const ex = (POLICY().pronoun_exclusion_names || []).filter(Boolean);
  if (ex.length && new RegExp('\\b(?:' + ex.map(escapeRe).join('|') + ')\\b').test(text)) return text;
  const named = new RegExp(OWNER_P + "(?![’'])");
  return splitSentences(text).map((sn) => (named.test(sn) ? sn : sn.replace(/\b[Hh]e\b(?!['’])/g, OWNER).replace(/\b[Hh]im\b/g, OWNER))).join(' ');
}

// ---------- False message-delivery claims ----------
// Blocks claims that *Tulip* saved/sent/passed on a message (or can/will), while the runtime cannot.
// Does not block descriptions of past project work ("He saved the model outputs", "results were saved").
const NEGATION = /\b(can(?:no|')?t|cannot|can not|unable|not able|don't|do not|doesn't|isn't|aren't|won't|wouldn't|no way|not yet|haven't|hasn't|didn't|never|not currently|not available|not implemented)\b/i;
const VERB = "(?:send|sent|sending|forward(?:ed|ing)?|pass(?:ed|ing)?(?:\\s+(?:along|on))?|relay(?:ed|ing)?|deliver(?:ed|ing)?|save[ds]?|saving|record(?:ed|ing)?|log(?:ged|ging)?|note[ds]?|notif(?:y|ied|ying)|inform(?:ed|ing)?|alert(?:ed|ing)?|e-?mail(?:ed|ing)?|text(?:ed|ing)?|message[ds]?|let\\s+him\\s+know|tell|told|store[ds]?)";
const OBJ = "(?:message|messages|note|request|details|information|info|contact|e-?mail|number|it|that|this|along|him|her|" + OWNER_P + "|your\\s+\\w+|the\\s+(?:message|note|request|details))";
const AGENT_CLAIM = new RegExp("\\b(?:i|we|tulip)(?:'ve|'ll|'m| have| will| am| can| could| would| shall| am going to| am able to| already| just| now| also| gladly| happily| definitely| certainly)*\\s+(?:also\\s+|just\\s+|now\\s+|already\\s+|gladly\\s+|happily\\s+|definitely\\s+)*(?:be\\s+)?(?:able\\s+to\\s+)?(?:go\\s+ahead\\s+and\\s+)?" + VERB + "\\b[^.!?\\n]{0,60}?\\b" + OBJ + "\\b", 'i');
const PASSIVE_CLAIM = /\b(?:your|the)\s+(?:message|note|request|details|contact(?:\s+details)?|information)\s+(?:has|have|had|was|were|will|is|'s|'ll)\s+(?:(?:be|been|now|already|safely)\s+)*(?:saved|sent|delivered|forwarded|passed(?:\s+(?:on|along))?|relayed|recorded|logged|received|stored|noted)\b/i;
const PROMISE_CLAIM = new RegExp('\\b(?:' + OWNER_P + '|he|she|they)\\s+(?:will|shall|would|is going to|\'ll)\\s+(?:receive|get|be notified|be informed|call|contact|reply|respond|get back|reach out|see)\\b', 'i');
const LET_KNOW = new RegExp('\\b(?:i|we)(?:\'ll|\'ve| will| have| can| could)?\\s+(?:also\\s+|just\\s+)?let\\s+(?:him|her|' + OWNER_P + ')\\s+know\\b', 'i');
const MSG_CONTEXT = /\b(message|note|request|contact|details|email|e-mail|call|reach|reply|notify|inform|forward|relay|pass)\b/i;

function claimsMessageHandling(text, flags) {
  if (flags && flags.message_saving && flags.external_delivery) return false;
  for (const s of splitSentences(text)) {
    if (NEGATION.test(s)) continue;
    if (/\?\s*$/.test(s)) continue; // a question ("Would you like me to send...?") is handled by prompt rules, not claims
    if (AGENT_CLAIM.test(s) && MSG_CONTEXT.test(s)) return true;
    if (LET_KNOW.test(s)) return true;
    if (PASSIVE_CLAIM.test(s)) return true;
    if (PROMISE_CLAIM.test(s)) return true;
  }
  return false;
}

// ---------- Farewell and introductions ----------
const FAREWELL = /\b(bye|goodbye|good bye|see you|take care|talk (?:to you )?later|have a (?:great|good|nice|wonderful|lovely) (?:day|one|evening|week|weekend)|that'?s (?:all|it)(?: for now)?|that will be all|no more questions|i'?m done|we'?re done|signing off|thank(?:s| you),? (?:that'?s all|for your time|for the (?:help|information|info|chat|details))|thank you for your time)\b/i;
function isFarewell(text) {
  const t = String(text || '');
  if (/\?/.test(t)) return false;
  return FAREWELL.test(t);
}
function isPureFarewell(text) {
  const t = String(text || '').trim();
  return isFarewell(t) && t.split(/\s+/).length <= 14;
}
const INTRO_ASKS = /\b(tell|explain|describe|discuss|know|details?|about|regarding|project|projects|hire|hiring|role|position|opening|vacanc\w+|interview|want|wants|would like|looking|need|available|availability)\b/i;
// A visitor who says who they or their organisation are gets a plain acknowledgement and "how can I help".
const AFFILIATION = /\b(?:i\s+(?:represent|work\s+(?:for|at|with|in))|i['’]?m\s+(?:with|from|an?\s+(?:\w+\s+){0,2}(?:at|from|with))|i\s+am\s+(?:with|from|an?\s+(?:\w+\s+){0,2}(?:at|from|with))|we\s+(?:are|['’]re)\s+(?:from|with|an?\s+(?:\w+\s+){0,3}(?:company|organi[sz]ation|firm|team|agency|startup))|we\s+(?:represent|work)|representing|on\s+behalf\s+of|my\s+(?:company|organi[sz]ation|firm|team)|(?:recruiter|hiring\s+manager|talent\s+(?:acquisition|partner)|hr)\s+(?:at|from|with|for))\b/i;
function isOrgIntro(text) {
  const t = String(text || '');
  return AFFILIATION.test(t);
}
// An introduction and nothing else (no question, no request): the reply is an acknowledgement and "how can I help".
function isIntroOnly(text) {
  const t = String(text || '').trim();
  return isOrgIntro(t) && !/\?/.test(t) && t.split(/\s+/).length <= 20 && !INTRO_ASKS.test(t);
}

// ---------- Output guard pipeline ----------
// Optional closing phrase (config fixed_text.farewell_suffix, empty by default): added to a farewell, removed from other answers.
function stripStraySuffix(text, allow) {
  const sfx = FIXED.farewell_suffix;
  if (allow || !sfx) return text;
  return text.replace(new RegExp('\\s*' + escapeRe(sfx.replace(/[!.]+$/, '')) + '[!.]?', 'ig'), '').replace(/\s{2,}/g, ' ').trim();
}

// ---------- Message requests and finance follow-ups (input side) ----------
const HIM = "(?:him|her|" + OWNER_P + (ALIAS_P.length ? "|" + ALIAS_P.join("|") : "") + ")";
const RELAY_VERB = "(?:tell|ask|let|inform|notify|remind)";
const MSG_REQUEST = [
  /\b(?:leave|send|pass|give|take|drop|forward|relay|submit)\b[^.?!]{0,40}\b(?:message|note|inquiry|enquiry|query)\b/i,
  new RegExp("(?:^|[.!?]\\s*)(?:please\\s+)?" + RELAY_VERB + "\\s+" + HIM + "\\b", 'i'),
  new RegExp("\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?" + RELAY_VERB + "\\s+" + HIM + "\\b", 'i'),
  new RegExp("\\bplease\\s+" + RELAY_VERB + "\\s+" + HIM + "\\b", 'i'),
  new RegExp("\\b(?:have|get)\\s+" + HIM + "\\s+(?:to\\s+)?(?:call|contact|email|reach|reply|respond|get back)", 'i'),
  /\b(?:leave|give|share|send|pass|forward|relay|provide)\b[^.?!]{0,20}\b(?:my|our)\s+(?:contact|details|info|information|e-?mail|number|phone)/i,
];
function isMessageRequest(text) { return MSG_REQUEST.some((re) => re.test(String(text || ''))); }

const FIN_FOLLOWUP = /\b(?:figure|figures|number|numbers|amount|amounts|range|digits?|ballpark|approximate|approximately|rough)\b|\bhow much\b|\b(?:confirm|verify)\s+(?:that|it|this)\b/i;
function isFinanceFollowUp(text, afterFinanceRefusal) {
  const t = String(text || '');
  return !!afterFinanceRefusal && t.trim().split(/\s+/).length <= 25 && FIN_FOLLOWUP.test(t);
}



// ---------- Output pipeline ----------
// Applies the output boundaries to a generated answer. Returns { text, triggered: [names] }.
// ctx: { flags, farewell, keepJai, afterFinanceRefusal }
function applyOutputGuards(text, ctx) {
  const c = ctx || {};
  const flags = c.flags || CFG.runtime_flags;
  const triggered = [];
  let out = String(text || '').trim();

  if (OFF_TOPIC_TOKEN.test(out)) { triggered.push('off_topic_redirect'); return { text: FIXED.scope_refusal, triggered }; }
  if (outputLeaksFinance(out)) { triggered.push('finance_leak'); return { text: FIXED.financial_refusal, triggered }; }
  if (containsSourceTerm(out)) { triggered.push('source_title'); return { text: FIXED.authored_source_withheld, triggered }; }
  if (claimsMessageHandling(out, flags)) { triggered.push('delivery_claim'); return { text: FIXED.authored_messaging_unavailable, triggered }; }

  if (out.startsWith(FIXED.welcome)) { out = out.slice(FIXED.welcome.length).trim(); triggered.push('welcome_repeat'); }

  // Clear failures are removed sentence by sentence; nothing else about wording is judged. If nothing is left, a short approved text is used.
  const sents = splitSentences(out);
  const drop = { authorship: 0, tool_name: 0, internal: 0 };
  const kept = sents.filter((sn) => {
    if (falseAuthorship(sn)) { drop.authorship++; return false; }
    if (mentionsAssistantTool(sn)) { drop.tool_name++; return false; }
    if (leaksInternals(sn)) { drop.internal++; return false; }
    return true;
  });
  if (drop.authorship) triggered.push('false_authorship_sentence_removed');
  if (drop.tool_name) triggered.push('tool_name_sentence_removed');
  if (drop.internal) triggered.push('internal_reference_sentence_removed');
  if (drop.authorship || drop.tool_name || drop.internal) {
    out = kept.join(' ').trim();
    if (!out) out = (drop.authorship || drop.tool_name) ? FIXED.authored_authorship_answer : FIXED.authored_claims_fallback;
  }

  const fi = fixInquiryOffers(out, flags);
  if (fi.changed) { triggered.push('inquiry_offer_replaced'); out = fi.text; }
  const dc = dedupeContact(out);
  if (dc.changed) { triggered.push('contact_offered_once'); out = dc.text; }

  if (/\*\*[^*\n]+\*\*/.test(out)) { out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1'); triggered.push('markdown_bold_removed'); }   // plain text only
  const n = normalisePronouns(out);
  if (n !== out) { triggered.push('pronouns_normalised'); out = n; }

  // After a finance refusal the next step is never an inquiry offer.
  if (c.afterFinanceRefusal && out.includes(EMAIL) && UNKNOWN_SENTENCE.test(out)) { triggered.push('finance_followup_refusal'); return { text: FIXED.financial_refusal, triggered }; }

  const allowSuffix = !!(c.farewell || c.keepSuffix);
  const before = out;
  out = stripStraySuffix(out, allowSuffix);
  if (out !== before) triggered.push('stray_farewell_suffix');
  const sfx = FIXED.farewell_suffix;
  if (c.farewell && sfx && !out.endsWith(sfx)) { out = (out + ' ' + sfx).trim(); triggered.push('farewell_suffix_added'); }
  if (!out) triggered.push('empty_after_guards');
  return { text: out, triggered };
}

// Trim a length-truncated answer back to its last complete sentence.
function trimToLastSentence(text) {
  const s = String(text || '').trim();
  const m = s.match(/^[\s\S]*[.!?](?=\s|$)/);
  return m ? m[0].trim() : s;
}

// ---------- History validation ----------
class ClientInstructionError extends Error {
  constructor(message) { super(message); this.name = 'ClientInstructionError'; this.code = 'client_system_message'; }
}

// Accepts only [{role:'user'|'assistant', content:string}]. Rejects system/developer/tool roles and extra fields.
// Bounds length, redacts source titles, and re-applies output guards to assistant messages so a forged or bad
// earlier message cannot carry a leak into the prompt.
function sanitizeHistory(history, limits, flags) {
  if (history == null) return [];
  if (!Array.isArray(history)) throw new ClientInstructionError('History must be an array.');
  const out = [];
  for (const m of history) {
    if (!m || typeof m !== 'object') throw new ClientInstructionError('Invalid history entry.');
    const extra = Object.keys(m).filter((k) => k !== 'role' && k !== 'content');
    if (extra.length) throw new ClientInstructionError('Unexpected field in history: ' + extra.join(','));
    if (m.role !== 'user' && m.role !== 'assistant') throw new ClientInstructionError('Client-supplied "' + String(m.role) + '" messages are not accepted.');
    if (typeof m.content !== 'string') throw new ClientInstructionError('History content must be text.');
    if (m.role === 'user') {
      let c = m.content.slice(0, limits.max_user_chars);
      if (isPersonalFinanceQuestion(c)) c = FINANCE_PLACEHOLDER;
      out.push({ role: 'user', content: redactSourceTerms(c).text });
    } else {
      const g = applyOutputGuards(m.content.slice(0, limits.max_assistant_chars), { flags, keepSuffix: true });
      out.push({ role: 'assistant', content: g.text });
    }
  }
  return out.slice(-(limits.max_turns * 2));
}

module.exports = {
  FIXED, CFG, OWNER, ASSISTANT, FINANCE_PLACEHOLDER, ownerPattern, fillText, ASSISTANT_TOOL_RE, TOOL_PLACEHOLDER,
  isPersonalFinanceQuestion, outputLeaksFinance, isMessageRequest, isFinanceFollowUp,
  containsSourceTerm, redactSourceTerms, redactAssistantTools, mentionsAssistantTool,
  claimsMessageHandling, falseAuthorship, leaksInternals,
  isFarewell, isPureFarewell, isOrgIntro, isIntroOnly,
  hasOffTopicToken: (t) => OFF_TOPIC_TOKEN.test(String(t || '')),
  applyOutputGuards, trimToLastSentence, fixInquiryOffers, dedupeContact, stripInquiryOffers, normalisePronouns, contactTail,
  splitSentences, sanitizeHistory, ClientInstructionError,
};

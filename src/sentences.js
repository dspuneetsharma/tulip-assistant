'use strict';
// Sentence splitting shared by guards and claim checks. Masks "Mr.", "e.g." etc. so they do not end a sentence.
function splitSentences(text) {
  const DOT = '․';
  const masked = String(text || '').replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|vs)\./g, '$1' + DOT).replace(/\b(e\.g|i\.e)\./gi, (m) => m.replace(/\./g, DOT));
  return masked.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim().split(DOT).join('.')).filter(Boolean);
}
// Pattern helpers use [^.] to stay inside one sentence. A title dot ("Mr.", "e.g.") would stop them, so patterns that must read across
// "Dr. Example" run on this text, where the title dots are removed ("Dr Example"). Offsets are not reused for editing the original.
function noTitle(text) {
  return String(text || '').replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|vs)\./g, '$1').replace(/\b(e)\.(g)\./gi, '$1$2').replace(/\b(i)\.(e)\./gi, '$1$2');
}
// A repaired sentence must still be a sentence. These endings and openings show that an edit cut it in the middle
// ("The pipeline's validation checks focused on."). Used before an automatic edit is accepted and as a last check on the answer.
const DANGLING_END = /\b(?:on|of|to|for|with|by|in|at|from|into|about|and|or|but|nor|the|a|an|that|which|as|than|such|using|via|between|during|through|over|under|against|while|where|whose|its|their|his|her|is|are|was|were|has|have|had|be|been|being|including|ensuring|focused|based|according)$/i;
const DANGLING_START = /^(?:and|or|whose|which|thereby|including|ensuring)\b/i;
function isFragment(sentence) {
  const t = String(sentence || '').trim().replace(/[.!?"”’')\]]+$/, '').trim();
  if (!t) return true;
  if (t.split(/\s+/).length < 3) return true;
  return DANGLING_END.test(t) || DANGLING_START.test(t);
}
module.exports = { splitSentences, noTitle, isFragment };

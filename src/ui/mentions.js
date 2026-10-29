// ============================================================
//  @MENTIONS — capability mention recognition (owner task 2026-10-29)
//
//  A user names a capability inside the composer draft with
//  "@<capability id>" ("@charts @deepseek-web 帮我…"). Recognition is a
//  PURE function of (text, installed ids) — no Vue, no DOM, no store —
//  so the composer popup, the mirror highlight, the send-time enable
//  pass and the timeline all see exactly the same mentions.
//
//  Owner rules (2026-10-29, revised the same day for CJK input):
//    - a mention is "@" immediately followed by a capability id;
//    - the "@" must sit at the text start OR after a character that is
//      NOT an ASCII letter/digit/./_/- . Whitespace, Chinese text and
//      full-width punctuation are all legal boundaries ("用@charts画个图"
//      mentions charts). An ASCII word character before the "@" glues it
//      into a longer token — "a@charts" and email addresses never mention;
//    - ids are [a-z0-9._-]; after the id the text must end, or continue
//      with whitespace/punctuation/ANY non-ASCII character. Only an
//      immediately following ASCII LETTER glues the id into a longer word
//      ("@chartsX" stays plain text; "@charts中文" mentions charts);
//    - only INSTALLED ids count; an unrecognized "@xxx" stays plain text
//      (no highlight, no enable, nothing at all);
//    - when the maximal id run is not installed, trailing [._-]
//      characters are backtracked ("@charts." ends the sentence with the
//      installed "charts"; "@charts.x" is NOT backtracked to "charts");
//    - the same id repeated in one message counts once (dedupe keeps the
//      first occurrence), while every occurrence keeps its span for the
//      highlight layers.
// ============================================================

// One id character: lowercase english, digits, dot, underscore, dash.
function isIdChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
    || ch === '.' || ch === '_' || ch === '-';
}

// The GLUE class: ASCII letters, digits, dot, underscore, dash. An "@"
// preceded by one of these is part of a longer ASCII token (a@charts,
// user@example.com, foo.@bar) and never starts a mention; anything else —
// whitespace, start of text, Chinese, full-width punctuation, other ASCII
// punctuation like "("/"," — is a legal boundary (owner decision
// 2026-10-29: CJK users write 用@charts画个图 without spaces).
function isAsciiWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
    || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '-';
}

function isMentionStart(text, at) {
  return at === 0 || !isAsciiWordChar(text[at - 1]);
}

// A mention must not run into a longer ASCII word: an immediately
// following ASCII LETTER kills the mention. Non-ASCII letters (中文, é)
// and punctuation terminate it cleanly — again the CJK no-space rule.
// Digits and ascii lowercase can never actually reach this check (they
// are id chars, consumed by the maximal run).
function endsCleanly(text, end) {
  if (end >= text.length) return true;
  if (/\s/.test(text[end])) return true;
  return !/[A-Za-z]/.test(text[end]);
}

// Parse one text against the installed capability ids.
//   occurrences: EVERY recognized mention, in text order, with
//                { id, start, end } spans (end exclusive) — for highlights.
//   mentions:    occurrences deduped by id (first appearance wins, keeps
//                its own span) — for the send-time semantics.
export function parseMentions(text, installedIds) {
  const installed = installedIds instanceof Set ? installedIds : new Set(installedIds || []);
  const src = String(text || '');
  const occurrences = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '@') continue;
    if (!isMentionStart(src, i)) continue;
    let runEnd = i + 1;
    while (runEnd < src.length && isIdChar(src[runEnd])) runEnd++;
    if (runEnd === i + 1) continue; // a bare "@" never mentions
    let id = null;
    let end = runEnd;
    for (let k = runEnd; k > i + 1; k--) {
      if (installed.has(src.slice(i + 1, k)) && endsCleanly(src, k)) {
        id = src.slice(i + 1, k);
        end = k;
        break;
      }
      // Shorter prefixes can only win when the dropped tail character was
      // a separator; a letter/digit tail would poison every shorter end.
      if (!/[._-]/.test(src[k - 1])) break;
    }
    if (!id) continue;
    occurrences.push({ id, start: i, end });
    i = end - 1; // the mention span is consumed
  }
  const mentions = [];
  const seen = new Set();
  for (const o of occurrences) {
    if (!seen.has(o.id)) {
      seen.add(o.id);
      mentions.push(o);
    }
  }
  return { mentions, occurrences };
}

// Split one text into renderable fragments: plain runs and mention runs
// (mention carries the capability id). Both mirror and timeline render
// these as text interpolation — never as HTML.
export function splitMentionFragments(text, installedIds) {
  const src = String(text || '');
  const { occurrences } = parseMentions(src, installedIds);
  const fragments = [];
  let cursor = 0;
  for (const o of occurrences) {
    if (o.start > cursor) fragments.push({ text: src.slice(cursor, o.start), mention: null });
    fragments.push({ text: src.slice(o.start, o.end), mention: o.id });
    cursor = o.end;
  }
  if (cursor < src.length) fragments.push({ text: src.slice(cursor), mention: null });
  return fragments;
}

// The "@…query" fragment the caret sits in, for the candidate popup:
// walking back from the caret there must be only id characters and then
// one boundary-valid "@". Returns { at, query } or null. The POPUP does
// not apply the after-id terminator rule — while typing, the terminator
// only comes into existence once more text follows.
export function mentionQueryBefore(text, caret) {
  const src = String(text || '');
  const at0 = Number(caret);
  if (!Number.isInteger(at0) || at0 < 1 || at0 > src.length) return null;
  let runStart = at0;
  while (runStart > 0 && isIdChar(src[runStart - 1])) runStart--;
  const at = runStart - 1;
  if (at < 0 || src[at] !== '@') return null;
  if (at > 0 && isAsciiWordChar(src[at - 1])) return null;
  return { at, query: src.slice(at + 1, at0) };
}

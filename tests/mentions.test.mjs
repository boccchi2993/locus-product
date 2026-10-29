// @-mentions recognition unit battery (owner task 2026-10-29, node, NO
// DOM). The pure module src/ui/mentions.js is the ONE recognizer shared
// by the composer popup, the mirror highlight, the send-time enable pass
// and the timeline; these checks pin the owner rules:
//
//   MN1  "@" at the text start mentions; a bare "@" never does
//   MN2  "@" after whitespace or a non-ASCII character mentions (CJK
//        boundary, owner decision 2026-10-29); glued "a@charts" and
//        email addresses never do
//   MN3  after the id: end of text, whitespace, punctuation or any
//        non-ASCII character terminates the mention; a following ASCII
//        letter ("@chartsX") glues it into a longer word — plain text
//   MN4  only INSTALLED ids count; unknown "@xxx" stays plain text
//   MN5  trailing separators are backtracked when the maximal id run is
//        not installed ("@charts." recognizes "charts"; "@charts.x"
//        does not; "@deepseek-web." keeps the dash inside the id)
//   MN6  repeats count once (dedupe keeps the FIRST occurrence) while
//        every occurrence keeps its own span for the highlight
//   MN7  ids are case-sensitive lowercase: "@Charts" never mentions
//   MN8  fragments: plain runs + mention runs, lossless round trip
//   MN9  mentionQueryBefore: the popup trigger — boundary-valid "@"
//        followed by 0..n id chars directly before the caret
//   MN10 mentions list carries first-occurrence spans in order
//   MN11 CJK boundaries (owner decision 2026-10-29): 中文前后不需要空格 —
//        用@charts画个图 mentions; only ASCII word chars glue on the
//        left, only ASCII letters glue on the right
//
// Run: node tests/mentions.test.mjs
import { parseMentions, splitMentionFragments, mentionQueryBefore } from '../src/ui/mentions.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const INSTALLED = ['charts', 'deepseek-web', 'joint.cap', 'web2'];
const ids = (text) => parseMentions(text, INSTALLED).mentions.map((m) => m.id).join(',');
const occ = (text) => parseMentions(text, INSTALLED).occurrences;
const spans = (list) => list.map((m) => m.id + '@' + m.start + '-' + m.end).join(',');

// ---------- MN1 start / bare @ ----------
check('MN1a @ at text start mentions', ids('@charts go') === 'charts');
check('MN1b a bare @ never mentions', ids('hi @ over here') === '');
check('MN1c @ followed by nothing (end of text) never mentions', ids('run @') === '');

// ---------- MN2 whitespace boundary ----------
check('MN2a @ after a space mentions', ids('use @charts please') === 'charts');
check('MN2b @ after a newline mentions', ids('one\ntwo @charts') === 'charts');
check('MN2c glued a@charts never mentions', ids('a@charts') === '');
check('MN2d an email address never mentions', ids('write to user@example.com now') === '');
check('MN2e ASCII punctuation before @ is a legal boundary (owner decision 2026-10-29: only ASCII word chars glue)',
  ids('see (@charts) now') === 'charts');

// ---------- MN3 terminator ----------
check('MN3a punctuation after the id terminates it', ids('try @charts.') === 'charts');
check('MN3b end of text terminates', ids('try @charts') === 'charts');
check('MN3c a comma terminates', ids('try @charts, then @deepseek-web') === 'charts,deepseek-web');
check('MN3d a following uppercase letter glues the word (plain text)',
  ids('try @chartsX now') === '');
check('MN3e CJK text after the id terminates it cleanly (owner decision 2026-10-29: 中文前后不需要空格)',
  ids('试试@charts中文') === 'charts');
check('MN3f two mentions separated by whitespace keep their order',
  ids('@charts @deepseek-web 帮我画图并总结') === 'charts,deepseek-web');

// ---------- MN4 unknown ids stay plain ----------
check('MN4a an unknown id is plain text (nothing recognized)',
  ids('use @nosuchcap now') === '');
check('MN4b an unknown id next to a real one does not disturb it',
  ids('@nosuchcap @charts') === 'charts');
check('MN4c mixed known+unknown: only known ids recognized',
  ids('@charts @nosuchcap @deepseek-web') === 'charts,deepseek-web');

// ---------- MN5 trailing-separator backtrack ----------
check('MN5a "@charts." ends the sentence with charts', ids('ok @charts.') === 'charts');
check('MN5b "@charts.x" does NOT backtrack into charts', ids('ok @charts.x') === '');
check('MN5c a dash inside the id survives a trailing period',
  ids('ok @deepseek-web.') === 'deepseek-web');
check('MN5d a dotted id keeps its dot and sheds the sentence period',
  ids('ok @joint.cap.') === 'joint.cap');
check('MN5e "@charts-" backtracks the trailing dash',
  ids('ok @charts-') === 'charts');
check('MN5f spans of MN5a end before the period',
  spans(occ('ok @charts.')) === 'charts@3-10', spans(occ('ok @charts.')));

// ---------- MN6 repeats ----------
const repeat = parseMentions('@charts draw and @charts again', INSTALLED);
check('MN6a repeated mentions count once', repeat.mentions.length === 1, JSON.stringify(repeat.mentions));
check('MN6b every occurrence keeps its span for the highlight',
  repeat.occurrences.length === 2 && repeat.occurrences[0].start === 0 && repeat.occurrences[1].start === 17,
  spans(repeat.occurrences));
check('MN6c the deduped mention keeps the FIRST occurrence span',
  repeat.mentions[0].start === 0 && repeat.mentions[0].end === 7);

// ---------- MN7 case sensitivity ----------
check('MN7a @Charts is not the id charts', ids('use @Charts now') === '');
check('MN7b @CHARTS breaks the id run entirely (uppercase is not an id char)',
  ids('use @CHARTS now') === '');
check('MN7c digits stay id chars: @web2 recognized',
  ids('use @web2 now') === 'web2');

// ---------- MN8 fragments ----------
const frags = splitMentionFragments('try @charts and @deepseek-web.', INSTALLED);
check('MN8a fragments split plain/mention/plain/mention/plain',
  frags.length === 5
    && frags[0].text === 'try ' && frags[0].mention === null
    && frags[1].text === '@charts' && frags[1].mention === 'charts'
    && frags[2].text === ' and '
    && frags[3].mention === 'deepseek-web'
    && frags[4].text === '.',
  JSON.stringify(frags));
check('MN8b fragment texts reassemble losslessly',
  frags.map((f) => f.text).join('') === 'try @charts and @deepseek-web.');
check('MN8c no mention at all → one plain fragment',
  splitMentionFragments('plain@mail.com', INSTALLED).length === 1);
check('MN8d empty text → empty fragment list',
  splitMentionFragments('', INSTALLED).length === 0);

// ---------- MN9 popup trigger ----------
check('MN9a a bare @ before the caret triggers with an empty query',
  JSON.stringify(mentionQueryBefore('go @', 4)) === '{"at":3,"query":""}');
check('MN9b the partial id is the query',
  JSON.stringify(mentionQueryBefore('@ch', 3)) === '{"at":0,"query":"ch"}');
check('MN9c the caret inside an id still sees the fragment',
  mentionQueryBefore('@charts x', 5).query === 'char');
check('MN9d a glued @ never triggers',
  mentionQueryBefore('a@ch', 4) === null);
check('MN9e an email caret never triggers',
  mentionQueryBefore('mail user@example.com', 21) === null);
check('MN9f an uppercase letter between @ and the caret breaks the fragment',
  mentionQueryBefore('@Ch', 3) === null);
check('MN9g a caret not after an @ never triggers',
  mentionQueryBefore('charts', 6) === null);
check('MN9h caret 0 never triggers',
  mentionQueryBefore('@charts', 0) === null);

// ---------- MN10 spans / order ----------
const two = parseMentions('@deepseek-web then @charts.', INSTALLED);
check('MN10a first-occurrence order with exact spans',
  spans(two.mentions) === 'deepseek-web@0-13,charts@19-26', spans(two.mentions));
check('MN10b occurrences carry every span in text order',
  spans(two.occurrences) === spans(two.mentions));

// ---------- MN11 CJK boundaries (owner decision 2026-10-29: 中文前后不需要空格) ----------
check('MN11a 用@charts画个图 mentions charts (no spaces needed)', ids('用@charts画个图') === 'charts');
check('MN11b two CJK-glued mentions in one sentence both recognized',
  ids('用@charts和@deepseek-web') === 'charts,deepseek-web');
check('MN11c an ASCII-letter-glued @ (email-like) stays unrecognized',
  ids('联系 a@charts.com') === '');
check('MN11d an ASCII letter after the id still glues the word',
  ids('用@chartsX的图') === '');
check('MN11e full-width punctuation before @ is a legal boundary',
  ids('（@charts）') === 'charts');
check('MN11f fragments highlight ONLY @charts inside CJK text',
  (() => {
    const f = splitMentionFragments('用@charts画个图', INSTALLED);
    return f.length === 3 && f[0].text === '用' && f[0].mention === null
      && f[1].text === '@charts' && f[1].mention === 'charts'
      && f[2].text === '画个图' && f[2].mention === null;
  })(), JSON.stringify(splitMentionFragments('用@charts画个图', INSTALLED)));
check('MN11g the popup trigger fires behind CJK text (用@)',
  JSON.stringify(mentionQueryBefore('用@', 2)) === '{"at":1,"query":""}');
check('MN11h a full-width comma terminates the id',
  ids('用@charts，谢谢') === 'charts');

console.log('---');
console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
process.exit(failed ? 1 : 0);

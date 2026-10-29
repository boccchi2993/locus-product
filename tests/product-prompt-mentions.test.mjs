// @-mentions environment-notes unit battery (owner task 2026-10-29,
// node, NO DOM). locusEnvironmentNotes gains ONE fixed-format line that
// teaches the model what "@<capability id>" in a user message means:
//
//   NP1  no taskEnvironment / no usable capability → the line is absent
//        (byte-identical to the pre-feature output)
//   NP2  the line lists EXACTLY the ready + needs-connection capability
//        ids (the same set the harness capability index lists); an
//        error-state capability never appears
//   NP3  the line format is verbatim: "@<capability id>" head, then
//        "Capability ids: <id> = <displayName>; …" entries
//   NP4  the ids list is SET-determined: sorted by id regardless of the
//        taskEnvironment array order, displayName fallback to id
//   NP5  the notes are a pure function of the enabled SET — the SAME
//        enabled set under two different mention texts yields
//        byte-identical notes (the notes never depend on the message)
//   NP6  ordering inside the notes: the mention line sits before the
//        optional toolOutputs line (which stays LAST)
//
// Run: node tests/product-prompt-mentions.test.mjs
import { locusEnvironmentNotes } from '../src/ui/product-prompt.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const MARK = 'In a user message, "@<capability id>" means';

const envOf = (...caps) => ({ capabilities: caps });

// ---------- NP1 absence without usable capabilities ----------
const plain = locusEnvironmentNotes({ workspace: null });
check('NP1a no taskEnvironment → no mention line', !plain.includes(MARK));
check('NP1b empty capabilities → no mention line',
  !locusEnvironmentNotes({ workspace: null, taskEnvironment: envOf() }).includes(MARK));
check('NP1c error-only capabilities → no mention line',
  !locusEnvironmentNotes({
    workspace: null,
    taskEnvironment: envOf({ id: 'charts', displayName: 'Charts', state: 'error' }),
  }).includes(MARK));
check('NP1d absence keeps the whole output byte-identical to no-taskEnvironment',
  locusEnvironmentNotes({ workspace: null })
    === locusEnvironmentNotes({ workspace: null, taskEnvironment: envOf() }));

// ---------- NP2 the listed set = ready + needs-connection ----------
const mixed = locusEnvironmentNotes({
  workspace: null,
  taskEnvironment: envOf(
    { id: 'charts', displayName: 'Charts', state: 'ready' },
    { id: 'deepseek-web', displayName: 'Deepseek Web', state: 'needs-connection' },
    { id: 'broken', displayName: 'Broken', state: 'error' },
  ),
});
check('NP2a the line appears when usable capabilities exist', mixed.includes(MARK));
check('NP2b ready and needs-connection ids are listed',
  mixed.includes('Capability ids: charts = Charts; deepseek-web = Deepseek Web;'),
  mixed.split('\n').filter((l) => l.includes(MARK)).join('\n'));
check('NP2c an error-state capability is never listed',
  !mixed.includes('broken'));

// ---------- NP3 verbatim line format ----------
const expectedLine = '- In a user message, "@<capability id>" means the user explicitly asks to use that'
  + ' capability in this task: read its guidance file(s) listed under Capabilities before starting.'
  + ' Capability ids: charts = Charts; deepseek-web = Deepseek Web;';
check('NP3 the full line matches the fixed format verbatim',
  mixed.split('\n').some((l) => l === expectedLine),
  JSON.stringify(mixed.split('\n').filter((l) => l.includes(MARK))));

// ---------- NP4 set-determinism: sorted by id, fallback name ----------
const unsorted = locusEnvironmentNotes({
  workspace: null,
  taskEnvironment: envOf(
    { id: 'web2', displayName: 'Web2', state: 'ready' },
    { id: 'charts', displayName: 'Charts', state: 'ready' },
  ),
});
const sorted = locusEnvironmentNotes({
  workspace: null,
  taskEnvironment: envOf(
    { id: 'charts', displayName: 'Charts', state: 'ready' },
    { id: 'web2', displayName: 'Web2', state: 'ready' },
  ),
});
check('NP4a the ids list is sorted by id, independent of array order', unsorted === sorted);
check('NP4b sorted list content',
  unsorted.includes('Capability ids: charts = Charts; web2 = Web2;'));
const fallback = locusEnvironmentNotes({
  workspace: null,
  taskEnvironment: envOf({ id: 'lonely', state: 'ready' }),
});
check('NP4c a missing displayName falls back to the id',
  fallback.includes('Capability ids: lonely = lonely;'));

// ---------- NP5 same enabled set, different mention texts ----------
// The notes function never sees the message; the property the owner
// requires (two differently-mentioning messages under one enabled set get
// IDENTICAL notes) holds because the output is a pure function of the
// environment snapshot. Both orderings of the SAME set must agree.
const setA = envOf(
  { id: 'charts', displayName: 'Charts', state: 'ready' },
  { id: 'deepseek-web', displayName: 'Deepseek Web', state: 'needs-connection' },
);
const setB = envOf(
  { id: 'deepseek-web', displayName: 'Deepseek Web', state: 'needs-connection' },
  { id: 'charts', displayName: 'Charts', state: 'ready' },
);
const notesOne = locusEnvironmentNotes({ workspace: null, taskEnvironment: setA });
const notesTwo = locusEnvironmentNotes({ workspace: null, taskEnvironment: setB });
check('NP5 one enabled set → byte-identical notes for both messages', notesOne === notesTwo);

// ---------- NP6 line ordering ----------
const withTools = locusEnvironmentNotes({
  workspace: null,
  toolOutputs: true,
  taskEnvironment: envOf({ id: 'charts', displayName: 'Charts', state: 'ready' }),
});
const mentionAt = withTools.indexOf(MARK);
const toolsAt = withTools.indexOf('- When a long tool output is truncated');
check('NP6a the mention line sits before the toolOutputs line',
  mentionAt >= 0 && toolsAt >= 0 && mentionAt < toolsAt,
  JSON.stringify({ mentionAt, toolsAt }));
check('NP6b the toolOutputs line is still the LAST line',
  withTools.endsWith('(read-only). Read it with head/tail/grep -n; to process it with python, cp it to /tmp first.'));

console.log('---');
console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
process.exit(failed ? 1 : 0);

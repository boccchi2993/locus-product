// M4a-B: production-graph OWNERSHIP gate (tests/m4a-product-ownership.test.cjs).
//
// What it proves, against the CURRENT production dependency closure (the
// real import graph reached from the page entry, not a keyword grep over
// the repository):
//   OWN1  index.html is ONE module entry (/src/main.js) and ZERO classic
//         page scripts (the M3c assembly shape stays).
//   OWN2  the closure derivation itself is sound: the entry resolves,
//         the graph is non-empty, and BOTH transfer layers
//         (src/product/runtime-api.js, src/product/harness-api.js) are
//         members — every byte of core code must enter through them.
//   OWN3  closure discipline: every relative import resolves to a real
//         file under src/ (no dangling edges, no adjacent-checkout or
//         node_modules escape), and bare specifiers are exactly
//         { vue } plus the two pinned cores — the core specifiers only
//         inside the two transfer layers, and only the public entry
//         specifiers ('locus-runtime', 'locus-runtime/workspace',
//         'locus-runtime/worker-assets', 'locus-harness'); any deeper
//         core subpath is a violation anywhere.
//   OWN4  no residual core assembly in the closure (comment-stripped):
//         the deleted __LOCUS_RUNTIME_CORE__ / __LOCUS_HARNESS_CORE__ /
//         __LOCUS_HARNESS_REPLAY_VALIDATION__ tables, eval and new
//         Function stay out of the production graph.
//   OWN5  ownership coverage: every JS/Vue file under src/ is reachable
//         from the entry, EXCEPT the single allowlisted module
//         src/capability-package.js — the Product authoring/package
//         boundary whose production-UI wiring is deliberately pending
//         (its header); the exemption is tied to a REAL consumer by
//         asserting the packaged storage gate's build input
//         (tests/m3c-storage-host.html) imports it, so the allowlist
//         entry fails loudly if that seam ever disappears.
//   OWN6..OWN13  NEGATIVE SELF-PROOFS: each forbidden shape is rebuilt
//         in a throwaway tree under the OS temp dir and run through the
//         SAME scanner code; each check asserts the specific violation
//         fires. The real worktree is never modified.
//
// Historical/test-side names (docs, fixtures, suites that read the
// installed pinned packages directly) are out of scope by design: this
// gate judges the production closure only.
//
// Run: node tests/m4a-product-ownership.test.cjs
// Registration: owned by the integration agent (run-unit.cjs is not
// modified by feature branches) — append this filename to SUITES in
// tests/run-unit.cjs.

const { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('fs');
const { dirname, join, resolve, relative, sep } = require('path');
const os = require('os');

const ROOT = resolve(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ============================================================
// Scanner — one implementation, used for the real tree AND for the
// fault-injection trees.
// ============================================================

// The only bare specifiers production code may use. Core specifiers are
// additionally file-restricted (OWN3).
const ALLOWED_BARE = new Set(['vue']);
const RUNTIME_LAYER = 'src/product/runtime-api.js';
const HARNESS_LAYER = 'src/product/harness-api.js';
// The public core entry specifiers and the ONLY files that may import them.
const PUBLIC_CORE_SPECS = {
  'locus-runtime': RUNTIME_LAYER,
  'locus-runtime/workspace': RUNTIME_LAYER,
  'locus-runtime/worker-assets': RUNTIME_LAYER,
  'locus-harness': HARNESS_LAYER,
};
// Any other locus-runtime/… or locus-harness/… subpath is a deep import —
// a violation no matter which file carries it.
const CORE_PREFIXES = ['locus-runtime/', 'locus-harness/'];
// src/ files allowed to sit OUTSIDE the production closure, each with its
// pinned justification (OWN5). Forward-slash repo-relative form.
const CLOSURE_EXEMPT = new Set(['src/capability-package.js']);
const RESIDUAL_TABLES = ['__LOCUS_RUNTIME_CORE__', '__LOCUS_HARNESS_CORE__', '__LOCUS_HARNESS_REPLAY_VALIDATION__'];

function scriptBlocks(fileText, isVue) {
  if (!isVue) return fileText;
  return (fileText.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || []).join('\n');
}

function importSpecifiers(fileText, isVue) {
  const text = scriptBlocks(fileText, isVue);
  const out = [];
  for (const m of text.matchAll(/(?:^|[^\w.])(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

function codeWithoutComments(fileText) {
  const noBlock = fileText.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlock.split('\n').map((line) => {
    const cut = line.indexOf('//');
    return cut === -1 ? line : line.slice(0, cut);
  }).join('\n');
}

function resolveRelative(root, fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, base + '.js', base + '.mjs', base + '.vue', join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function deriveClosure(root) {
  const violations = [];
  const entryHtml = join(root, 'index.html');
  if (!existsSync(entryHtml)) {
    return { files: new Set(), violations: [{ kind: 'entry-missing', file: 'index.html' }] };
  }
  const html = readFileSync(entryHtml, 'utf8');
  const classicTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  if (classicTags.length > 0) violations.push({ kind: 'entry-classic-script', file: 'index.html', spec: classicTags.join(',') });
  const moduleTags = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const expectedEntry = '/src/main.js';
  if (!(moduleTags.length === 1 && moduleTags[0] === expectedEntry)) {
    violations.push({ kind: 'entry-module-script', file: 'index.html', spec: JSON.stringify(moduleTags) });
  }

  const files = new Set();
  const bare = new Map();
  const queue = [];
  for (const tag of moduleTags) {
    const entry = join(root, tag.replace(/^\//, ''));
    if (existsSync(entry)) queue.push(entry);
    else violations.push({ kind: 'dangling-import', file: 'index.html', spec: tag });
  }
  const srcRoot = join(root, 'src');
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const isVue = file.endsWith('.vue');
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'), isVue)) {
      if (spec.startsWith('.')) {
        const target = resolveRelative(root, file, spec);
        const rel = relative(root, file);
        if (target === null) {
          violations.push({ kind: 'dangling-import', file: rel, spec });
        } else if (!(target === srcRoot || target.startsWith(srcRoot + sep))) {
          violations.push({ kind: 'outside-repository', file: rel, spec });
        } else if (!target.endsWith('.css')) {
          queue.push(target);
        }
      } else {
        const rel = relative(root, file).split('\\').join('/');
        if (PUBLIC_CORE_SPECS[spec]) {
          if (PUBLIC_CORE_SPECS[spec] !== rel) {
            violations.push({ kind: 'core-import-outside-transfer-layer', file: rel, spec });
          }
        } else if (CORE_PREFIXES.some((p) => spec.startsWith(p))) {
          violations.push({ kind: 'core-deep-import', file: rel, spec });
        } else if (!ALLOWED_BARE.has(spec)) {
          violations.push({ kind: 'undeclared-dependency', file: rel, spec });
        }
        if (!bare.has(spec)) bare.set(spec, []);
        bare.get(spec).push(rel);
      }
    }
  }

  for (const file of files) {
    const code = codeWithoutComments(readFileSync(file, 'utf8'));
    for (const table of RESIDUAL_TABLES) {
      if (code.includes(table)) violations.push({ kind: 'residual-assembly', file: relative(root, file), spec: table });
    }
    if (/\beval\s*\(/.test(code)) violations.push({ kind: 'residual-assembly', file: relative(root, file), spec: 'eval(' });
    if (/\bnew\s+Function\s*\(/.test(code)) violations.push({ kind: 'residual-assembly', file: relative(root, file), spec: 'new Function(' });
  }
  return { files, bare, violations };
}

// ============================================================
// OWN1–OWN5 — the REAL production tree must pass everything
// ============================================================
{
  const { files, violations } = deriveClosure(ROOT);
  const rel = (f) => relative(ROOT, f).split('\\').join('/');
  const closureRels = [...files].map(rel);

  check('OWN1.entry-one-module-no-classic',
    !violations.some((v) => v.kind === 'entry-classic-script' || v.kind === 'entry-module-script'),
    JSON.stringify(violations.filter((v) => v.kind.startsWith('entry-'))));

  check('OWN2.closure-nonempty-with-transfer-layers',
    files.size > 0
    && closureRels.includes('src/product/runtime-api.js')
    && closureRels.includes('src/product/harness-api.js')
    && closureRels.includes('src/main.js'),
    'closure size ' + files.size);

  const graphViolations = violations.filter((v) => !v.kind.startsWith('entry-'));
  check('OWN3.closure-graph-clean',
    graphViolations.length === 0
    && [...files].every((f) => f === join(ROOT, 'src') || f.startsWith(join(ROOT, 'src') + sep)),
    JSON.stringify(graphViolations));

  check('OWN4.no-residual-assembly-in-closure',
    !violations.some((v) => v.kind === 'residual-assembly'),
    JSON.stringify(violations.filter((v) => v.kind === 'residual-assembly')));

  // Ownership coverage: walk src/ and demand closure membership except the
  // explicit allowlist (whose real consumer is asserted right after).
  const allSrc = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else allSrc.push(p);
    }
  })(join(ROOT, 'src'));
  const orphans = allSrc
    .filter((f) => !f.endsWith('.css'))
    .map(rel)
    .filter((f) => !files.has(join(ROOT, f)) && !CLOSURE_EXEMPT.has(f));
  check('OWN5.no-unowned-src-files',
    orphans.length === 0,
    'outside closure and not allowlisted: ' + JSON.stringify(orphans));

  const exemptPath = [...CLOSURE_EXEMPT][0];
  const exemptReallyBuilt = readFileSync(join(ROOT, 'tests', 'm3c-storage-host.html'), 'utf8')
    .includes("../src/capability-package.js");
  check('OWN5.exemption-has-real-consumer',
    existsSync(join(ROOT, exemptPath.split('/').join(sep))) && exemptReallyBuilt,
    'the allowlisted ' + exemptPath + ' must stay a real build input of the packaged storage gate');
}

// ============================================================
// OWN6–OWN13 — negative self-proofs in throwaway trees
// ============================================================
function buildTree(files) {
  const base = mkdtempSync(join(os.tmpdir(), 'm4a-ownership-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(base, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return base;
}

const ENTRY_HTML = [
  '<!DOCTYPE html><html><body><div id="app"></div>',
  '<script type="module" src="/src/main.js"><\/script>',
  '</body></html>',
].join('\n');
const MAIN_OK = "import { createApp } from 'vue';\nimport * as runtimeApi from './product/runtime-api.js';\nimport * as harnessApi from './product/harness-api.js';\nconsole.log(createApp, runtimeApi, harnessApi);\n";
const RUNTIME_LAYER_SRC = "export * from 'locus-runtime';\n";
const HARNESS_LAYER_SRC = "export * from 'locus-harness';\n";
const CLEAN_TREE = {
  'index.html': ENTRY_HTML,
  'src/main.js': MAIN_OK,
  'src/product/runtime-api.js': RUNTIME_LAYER_SRC,
  'src/product/harness-api.js': HARNESS_LAYER_SRC,
};

function violationKinds(root) {
  return deriveClosure(root).violations.map((v) => v.kind);
}

function expectViolation(name, kind, extraFiles) {
  let base = null;
  try {
    base = buildTree({ ...CLEAN_TREE, ...extraFiles });
    const kinds = violationKinds(base);
    check(name, kinds.includes(kind),
      'expected ' + kind + ', got ' + JSON.stringify(kinds));
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
  }
}

expectViolation('OWN6.classic-script-tag-detected', 'entry-classic-script', {
  'index.html': ENTRY_HTML + '\n<script src="/src/legacy.js"><\/script>',
});
expectViolation('OWN7.core-import-outside-transfer-layer-detected', 'core-import-outside-transfer-layer', {
  'src/ui/store.js': "import { createAgentSession } from 'locus-harness';\nconsole.log(createAgentSession);\n",
  // reachable, or the scanner never visits the violating file
  'src/main.js': MAIN_OK + "import './ui/store.js';\n",
});
expectViolation('OWN8.core-deep-import-detected', 'core-deep-import', {
  'src/product/runtime-api.js': "export * from 'locus-runtime/src/index.js';\n",
});
expectViolation('OWN9.undeclared-dependency-detected', 'undeclared-dependency', {
  'src/main.js': MAIN_OK + "import _ from 'lodash';\nconsole.log(_);\n",
});
expectViolation('OWN10.dangling-import-detected', 'dangling-import', {
  'src/main.js': MAIN_OK + "import { ghost } from './ghost.js';\nconsole.log(ghost);\n",
});
{
  // Adjacency: a file OUTSIDE the tree root reached through a relative
  // import — the sibling lives next to the temp root, never inside the
  // real worktree.
  let base = null;
  try {
    base = buildTree({ ...CLEAN_TREE, 'src/adjacent.js': "import { leak } from '../../m4a-ownership-sibling/secret.js';\nconsole.log(leak);\n", 'src/main.js': MAIN_OK + "import './adjacent.js';\n" });
    mkdirSync(join(dirname(base), 'm4a-ownership-sibling'), { recursive: true });
    writeFileSync(join(dirname(base), 'm4a-ownership-sibling', 'secret.js'), 'export const leak = 1;\n');
    const kinds = violationKinds(base);
    check('OWN11.adjacent-checkout-import-detected', kinds.includes('outside-repository'),
      'expected outside-repository, got ' + JSON.stringify(kinds));
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
  }
}
expectViolation('OWN12.residual-core-table-detected', 'residual-assembly', {
  'src/ui/store.js': "const core = globalThis.__LOCUS_RUNTIME_CORE__;\nif (core) console.log(core);\n",
  'src/main.js': MAIN_OK + "import './ui/store.js';\n",
});
expectViolation('OWN13.eval-in-production-detected', 'residual-assembly', {
  'src/tools.js': "export const boom = () => eval('1 + 1');\n",
  'src/main.js': MAIN_OK + "import './tools.js';\n",
});

// The scanner must not fire on the historical COMMENT mentions (they are
// how persistence.js documents the deleted tables).
{
  let base = null;
  try {
    base = buildTree({
      ...CLEAN_TREE,
      'src/persistence.js': "// one-way delegates over the deleted __LOCUS_HARNESS_REPLAY_VALIDATION__ table\nexport const x = 1;\n",
    });
    const kinds = violationKinds(base);
    check('OWN4.comment-mentions-do-not-fire', !kinds.includes('residual-assembly'),
      'got ' + JSON.stringify(kinds));
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
  }
}

console.log(`\nm4a-product-ownership: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

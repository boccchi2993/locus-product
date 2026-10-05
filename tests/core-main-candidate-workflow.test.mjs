// M4a review round 1, F1: guard the candidate workflow's input channel.
//
// Two layers, both against the REAL artifacts (no copied "safe implementation"):
//
//   WF1  structural scan of .github/workflows/core-main-candidate.yml —
//        no '${{' expression, eval, or `bash -c` may appear inside any run
//        block (shell source must stay static), and every inputs.* reference
//        must sit in an env-value position (data channel, not source). The
//        capture step must not pick the source mode in shell at all.
//   WF2  the tool is spawned as a SUBPROCESS exactly the way the workflow
//        invokes it (node scripts/core-main-candidate.mjs …, inputs in env) —
//        hostile values (quote-close, command substitution, backticks,
//        semicolons, newlines) must be rejected as plain data with exit 2,
//        and a harmless marker must never execute or reach the output.
//
// Run: node tests/core-main-candidate-workflow.test.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'core-main-candidate.yml');
const TOOL = join(ROOT, 'scripts', 'core-main-candidate.mjs');

// ---------------------------------------------------------------------------
// WF1: structural scan

function scanRunBlocks(text) {
  // Returns { problems, inputRefs } — run blocks are found by indentation
  // (block scalars and inline scalars), which is all this workflow uses.
  const problems = [];
  const inputRefs = [];
  const lines = text.split(/\r?\n/);
  let blockIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const runHead = /^(\s*)run:(.*)$/.exec(line);
    if (runHead) {
      const rest = runHead[2];
      if (rest.trim() === '' || /^[|>][-+0-9]*$/.test(rest.trim())) {
        blockIndent = runHead[1].length; // block scalar: body is MORE indented
        continue;
      }
      if (rest.includes('${{')) {
        problems.push(`line ${i + 1}: inline run source contains an expression: ${rest.trim().slice(0, 80)}`);
      }
      continue;
    }
    if (blockIndent !== null) {
      if (line.trim() === '') continue;
      const indent = line.match(/^\s*/)[0].length;
      if (indent > blockIndent) {
        if (line.includes('${{')) {
          problems.push(`line ${i + 1}: run source contains an expression: ${line.trim().slice(0, 80)}`);
        }
        if (/\beval\b/.test(line) || line.includes('bash -c') || line.includes('bash  -c')) {
          problems.push(`line ${i + 1}: run source re-interprets strings (eval/bash -c): ${line.trim().slice(0, 80)}`);
        }
        continue;
      }
      blockIndent = null; // dedent — the block ended
    }
    if (line.includes('${{ inputs.')) inputRefs.push({ line: i + 1, text: line.trim() });
  }
  return { problems, inputRefs };
}

function structuralChecks() {
  const text = readFileSync(WORKFLOW, 'utf8');
  const { problems, inputRefs } = scanRunBlocks(text);
  check('WF1 no expression/eval/bash -c inside any run block', problems.length === 0,
    JSON.stringify(problems));
  check('WF1 dispatch inputs flow through the env channel', inputRefs.length >= 3,
    `found ${inputRefs.length} inputs.* references`);
  const nonEnv = inputRefs.filter((r) => !/^[A-Z_][A-Z0-9_]*:\s*\$\{\{ inputs\./.test(r.text));
  check('WF1 every inputs.* reference is an env value', nonEnv.length === 0,
    JSON.stringify(nonEnv));
  const captureBlock = text.includes('node scripts/core-main-candidate.mjs capture --checkout .');
  check('WF1 capture step passes no mode/SHA flags in shell', captureBlock
    && !/capture --checkout \.[^\n]*--source/.test(text)
    && !/capture --checkout \.[^\n]*--runtime-sha/.test(text));
  check('WF1 schedule trigger still present (main mode is its default)',
    /on:\s*\n\s+schedule:/.test(text));
}

// ---------------------------------------------------------------------------
// WF2: subprocess validation via env — the workflow's invocation shape

const VALID_RT = '2435a57ff7a66db3db88aa98a88d404c75133483';
const VALID_HS = '347eed99a415dc080b97d46d8a4271ceb19c5142';
const MARKER = 'CAND_MARKER_RAN';

function makeCheckout(dir) {
  mkdirSync(dir, { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'workflow-fixture', version: '0.0.0', private: true, type: 'module',
    dependencies: { 'locus-harness': `github:boccchi2993/locus-harness#${VALID_HS}`,
      'locus-runtime': `github:boccchi2993/locus-runtime#${VALID_RT}`, vue: '^3.5.13' },
  }, null, 2) + '\n');
  g(['init', '-q', '-b', 'main']);
  g(['add', '-A']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']);
  return g(['rev-parse', 'HEAD']).stdout.trim();
}

function runTool(args, envOverrides, cwd) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', cwd: cwd || ROOT,
    env: { ...process.env, ...envOverrides },
  });
}

function subprocessChecks(tmp) {
  const fixture = join(tmp, 'wf-fixture');
  const sha = makeCheckout(fixture);

  const HOSTILE = [
    ['quote-close + command substitution', `0000000000000000000000000000000000000000'; ${MARKER}; echo '`],
    ['dollar-paren substitution', `0000000000000000000000000000000000000000$(${MARKER})`],
    ['backtick substitution', '0000000000000000000000000000000000000000`echo ' + MARKER + '`'],
    ['semicolon chain', '0000000000000000000000000000000000000000; echo ' + MARKER],
    ['newline payload', `0000000000000000000000000000000000000000\necho ${MARKER}`],
    ['short non-hex', 'abc; def'],
    ['uppercase', 'A'.repeat(40)],
  ];
  for (const [name, value] of HOSTILE) {
    const out = join(tmp, `snap-${Math.abs(value.length * 31 + value.charCodeAt(0))}.json`);
    const r = runTool(['capture', '--checkout', fixture, '--out', out], {
      CAND_SOURCE: 'explicit', CAND_RUNTIME_SHA: value, CAND_HARNESS_SHA: VALID_HS,
    });
    const combined = (r.stdout || '') + (r.stderr || '');
    check(`WF2 hostile runtime_sha rejected as data: ${name}`,
      r.status === 2 && !combined.includes(MARKER) && !existsSync(out),
      JSON.stringify({ exit: r.status, marker: combined.includes(MARKER), out: existsSync(out) }));
  }

  const hostileSource = runTool(['capture', '--checkout', fixture], {
    CAND_SOURCE: `explicit; echo ${MARKER}`,
    CAND_RUNTIME_SHA: VALID_RT, CAND_HARNESS_SHA: VALID_HS,
  });
  check('WF2 hostile source value rejected as data',
    hostileSource.status === 2 && !(hostileSource.stdout + hostileSource.stderr).includes(MARKER),
    JSON.stringify({ exit: hostileSource.status }));

  const legalOut = join(tmp, 'snap-legal.json');
  const legal = runTool(['capture', '--checkout', fixture, '--out', legalOut], {
    CAND_SOURCE: 'explicit', CAND_RUNTIME_SHA: VALID_RT, CAND_HARNESS_SHA: VALID_HS,
  });
  let legalOk = legal.status === 0 && existsSync(legalOut);
  let legalSnap = null;
  if (legalOk) {
    legalSnap = JSON.parse(readFileSync(legalOut, 'utf8'));
    legalOk = legalSnap.source === 'explicit' && legalSnap.product.commit === sha
      && legalSnap.cores['locus-runtime'].sha === VALID_RT;
  }
  check('WF2 legal full SHAs pass via env and bind the real Product commit', legalOk,
    JSON.stringify({ exit: legal.status }));

  // schedule shape: no inputs at all → main mode is selected. To prove mode
  // selection WITHOUT touching the network, the checkout is a repo with no
  // commits: main mode fails AFTER validation at the product-HEAD read
  // (exit 10), while explicit mode would fail earlier with a usage error
  // (exit 2) demanding the missing SHAs.
  const unborn = join(tmp, 'wf-unborn');
  mkdirSync(unborn, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: unborn });
  const mainMode = runTool(['capture', '--checkout', unborn], {
    CAND_SOURCE: '', CAND_RUNTIME_SHA: '', CAND_HARNESS_SHA: '',
  });
  check('WF2 empty inputs (schedule shape) enter main mode, not explicit',
    mainMode.status === 10 && (mainMode.stderr || '').includes('could not read the Product commit'),
    JSON.stringify({ exit: mainMode.status, err: (mainMode.stderr || '').slice(0, 120) }));
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'core-main-candidate-workflow-test-'));
  try {
    structuralChecks();
    subprocessChecks(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : `all ${passed} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('SUITE ERROR', e); process.exitCode = 1; });

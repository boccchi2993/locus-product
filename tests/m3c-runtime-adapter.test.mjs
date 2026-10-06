// M3c-A dedicated gate — Runtime / tool-execution adaptation (repository
// split, three-repo switch). Exercises the REAL production chain with NO
// local core and NO second adapter:
//
//   real installed locus-runtime (via src/product/runtime-api.js, the ONLY
//   permitted specifier) → real RuntimeSession.execute → real executeTool
//   (src/tools.js, ES module) → real LocusMutationPolicy (src/mutation-
//   policy.js, ES module) → real VFS.
//
//   RA1  runtime-api.js re-export surface = the exact union of the
//        package's real entries (no extras, no loss); worker assets live
//        under the runtimeWorkerAssets namespace;
//   RA2  repo-wide specifier audit: no `locus-runtime` import outside
//        runtime-api.js; A's files import nothing local (no src/runtime,
//        no src/shell, no require). M3c integration: tools.js imports
//        EXACTLY the Product telemetry module (A's recorded §3 follow-up
//        — D converted telemetry.js to ESM);
//   RA3  executeTool stays the ONLY tool route: bash goes through the
//        injected opts.runtimeSession.execute, never a local shell call;
//   T1   real shell write + read back through executeTool (UTF-8 io
//        accounting through the Product telemetry helpers);
//   T2   the model-visible tool registry is byte-stable (bash/cloud_bash);
//   T3   user-visible refusals keep their exact copy (cloud_bash, unknown
//        tool, missing runtime session) and every one is a FAILURE;
//   T4   the page-default telemetry sink (the Telemetry global) still
//        receives the record when opts.telemetry is absent;
//   MP1-4  the Product ~/.skills policy plumbs THROUGH executeTool →
//        session → shell: byte-stable refusal texts, nothing moved, and
//        no over-blocking outside the tree;
//   S1   a per-call signal truly reaches the Runtime (pre-aborted call is
//        refused by the RUNTIME's own cancellation, before any effect);
//   S2/S3  entered/release barrier: a caller abort while a dispatched
//        provider write is unsettled — nothing settles before release,
//        the settled effect is kept (no rollback), the run is reported
//        FAILED (never converted into a success), and a chained
//        subsequent operation is NOT dispatched;
//   B1/B2  session boundary / dispose mid-write: the boundary failure is
//        not masked by the tool-result wrapping (success=false + telemetry
//        failure), effects stay, and the refused successor state is loud.
//
// Ordering is proven by REACHED STATES (entered/released flags), never by
// sleeps; timeouts are marked failure bounds only. Every parking block
// restores the provider method and disposes its chain in a finally.
//
// Run: node tests/m3c-runtime-adapter.test.mjs
// (suite registration in tests/run-unit.cjs is D's final wiring — recorded
// in docs/M3C-A-HANDOFF.md)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (...p) => readFileSync(join(root, ...p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// State-based barrier: waits until condFn REACHES true; the timeout is the
// failure bound, never the ordering proof.
async function waitFor(desc, condFn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = !!(await condFn()); } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + desc);
    await new Promise((r) => setTimeout(r, 4));
  }
}

// Marked failure bound for awaited execution promises.
function withTimeout(promise, ms, label) {
  let timer;
  const bound = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('marked timeout: ' + label)), ms);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

// Negative (non-settlement) proof: let the machine run a bounded burst of
// macrotask turns, then report whether the flag flipped. The LIFECYCLE
// order comes from the entered/released state flags — this only checks
// that no settlement happened across those turns.
async function stayedUnsettled(flagObj, turns = 25) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
  return flagObj.settled === false;
}

// The REAL Product telemetry module, imported the same way the product
// graph now does (M3c integration: src/telemetry.js is an ES module and
// tools.js imports { Telemetry, utf8ByteLength } from it statically —
// A's recorded §3 follow-up, performed by D). No copy is created here —
// this binds the page-default sink to the SAME Product-owned
// implementations.
await import('../src/telemetry.js');

// ---------- the REAL production pieces under test ----------
const runtimeApi = await import('../src/product/runtime-api.js');
const tools = await import('../src/tools.js');
const { executeTool, AGENT_TOOL_DEFINITIONS } = tools;
const { LocusMutationPolicy } = await import('../src/mutation-policy.js');

// One chain per scenario block: real host + session + workspace. The
// worker assets ride the runtimeWorkerAssets namespace exactly as the
// frozen interface prescribes.
async function freshChain(tag) {
  const host = await runtimeApi.createRuntime({
    workerAssets: {
      pyWorkerSource: runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE,
      grepWorkerSource: runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE,
    },
  });
  const session = host.createSession();
  const vfs = runtimeApi.createWorkspace();
  return {
    host, session, vfs,
    telemetry: { records: [], record(r) { this.records.push(r); return r; } },
    tag,
  };
}

// A recording park over a REAL memory provider: the shell's `>` write for
// the marker FILE is held until the test releases it. Providers receive
// MOUNT-RELATIVE paths, so the match is on the file name; the follow-up
// `-after` names never match. Everything else passes straight through to
// the real provider.
function parkProviderWrites(provider, markerFile) {
  const origWrite = provider.write.bind(provider);
  const state = { entered: 0, paths: [], release: null, released: 0 };
  provider.write = (path, data) => {
    if (!String(path).endsWith(markerFile)) return origWrite(path, data);
    state.entered++;
    state.paths.push(String(path));
    return new Promise((resolve, reject) => {
      state.release = () => { state.released++; origWrite(path, data).then(resolve, reject); };
    });
  };
  state.restore = () => { provider.write = origWrite; };
  return state;
}

// Source-text audits judge CODE, not the explanatory banner comments.
function codeOf(src) {
  return src.replace(/^\s*\/\/.*$/gm, '');
}

const IDENTITY_MSG = 'Skill instance paths are stable; edit the skill in place, '
  + 'delete the individual skill with approval, or remove/re-add the capability.';

async function run() {
  // ================= RA1. runtime-api export surface =================
  {
    // The package entries are imported DIRECTLY here as the surface
    // witness: product code may never do this (RA2 pins that), the
    // dedicated gate is the consumer-side evidence that the api file
    // neither loses nor invents exports.
    const rootEntry = await import('locus-runtime');
    const wsEntry = await import('locus-runtime/workspace');
    const expected = [...Object.keys(rootEntry), ...Object.keys(wsEntry)].sort();
    const actual = Object.keys(runtimeApi).filter((k) => k !== 'runtimeWorkerAssets').sort();
    check('RA1 runtime-api re-exports exactly the union of the real entries (no extras, no loss)',
      JSON.stringify(actual) === JSON.stringify(expected),
      JSON.stringify({ actual, expected }));
    check('RA1 the worker assets ride the runtimeWorkerAssets namespace (real, non-empty sources)',
      Object.keys(runtimeApi.runtimeWorkerAssets).sort().join(',') === 'GREP_WORKER_SOURCE,PY_WORKER_SOURCE'
        && typeof runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE === 'string'
        && runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE.trim().length > 0
        && typeof runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE === 'string'
        && runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE.trim().length > 0,
      JSON.stringify(Object.keys(runtimeApi.runtimeWorkerAssets)));
    check('RA1 the api file publishes nothing global and adds no export beyond the frozen §3 shape (code only)',
      (() => {
        const code = codeOf(readSrc('src', 'product', 'runtime-api.js'));
        const exportLines = code.split('\n').filter((l) => /^export\s/.test(l.trim()));
        return !/\bglobalThis\b|\bwindow\b/.test(code)
          && exportLines.length === 3
          && exportLines[0] === "export * from 'locus-runtime';"
          && exportLines[1] === "export * from 'locus-runtime/workspace';"
          && exportLines[2] === "export * as runtimeWorkerAssets from 'locus-runtime/worker-assets';";
      })(),
      'runtime-api.js must stay the frozen §3 shape');
  }

  // ================= RA2/RA3. static audits (A's files) =================
  {
    const toolsSrc = codeOf(readSrc('src', 'tools.js'));
    const policySrc = codeOf(readSrc('src', 'mutation-policy.js'));
    const toolImports = [...toolsSrc.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]);
    check('RA2 tools.js imports ONLY the Product telemetry module (no core import, no local shell/core, no require)',
      !/\brequire\s*\(/.test(toolsSrc)
        && !toolsSrc.includes('locus-runtime') && !toolsSrc.includes('src/runtime')
        && !toolsSrc.includes('runShellCommand')
        && toolImports.length === 1 && toolImports[0] === './telemetry.js',
      'imports: ' + JSON.stringify(toolImports));
    check('RA2 mutation-policy.js imports nothing and references no core',
      !/(^|\n)\s*import\s|\brequire\s*\(/.test(policySrc)
        && !policySrc.includes('locus-runtime') && !policySrc.includes('src/runtime'),
      'the policy is self-contained Product knowledge');
    check('RA3 executeTool routes bash ONLY through the injected runtimeSession.execute',
      toolsSrc.includes('runtimeSession.execute')
        && toolImports.every((spec) => spec === './telemetry.js')
        && /throw new Error\('bash: no runtime session injected'\)/.test(toolsSrc),
      'no local shell shortcut, no import-based fallback (the one telemetry import is RA2-pinned)');

    // Repo-wide: no product file may import the package outside the api file.
    const { readdirSync, statSync } = await import('node:fs');
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (!/node_modules|components|product$/.test(name)) walk(p); continue; }
        if (!/\.(js|mjs)$/.test(name) || p.endsWith('runtime-api.js')) continue;
        if (readFileSync(p, 'utf8').includes('locus-runtime')) offenders.push(p);
      }
    };
    walk(join(root, 'src'));
    check('RA2 no product file imports locus-runtime outside src/product/runtime-api.js',
      offenders.length === 0, JSON.stringify(offenders));
  }

  // ================= T1. real shell write/read through executeTool =================
  {
    const c = await freshChain('t1');
    try {
      const cmd = 'echo 你好 m3c-a > /tmp/m3c-a-t1.txt && cat /tmp/m3c-a-t1.txt';
      const res = await withTimeout(
        executeTool('bash', cmd, c.vfs, { runtimeSession: c.session, telemetry: c.telemetry }),
        30000, 'T1 executeTool');
      const back = await c.vfs.read('/tmp/m3c-a-t1.txt').catch(() => null);
      check('T1 the real RuntimeSession executed the shell write and the bytes are on the real VFS',
        res.success === true && typeof back === 'string' && back.includes('你好 m3c-a'),
        JSON.stringify({ success: res.success, read: String(back).slice(0, 40) }));
      check('T1 the tool result carries the runtime output and backend',
        typeof res.output === 'string' && res.output.includes('你好 m3c-a')
          && typeof res.backend === 'string' && res.backend.length > 0,
        JSON.stringify({ output: String(res.output).slice(0, 40), backend: res.backend }));
      const rec = c.telemetry.records[c.telemetry.records.length - 1];
      check('T1 exactly one telemetry record with honest UTF-8 io accounting (the telemetry.js helpers, not char counts)',
        c.telemetry.records.length === 1 && rec && rec.tool === 'bash' && rec.success === true
          && rec.input_bytes > 0 && rec.output_bytes > 0
          && rec.output_bytes > String(res.output).length,
        JSON.stringify(rec));
    } finally { c.host.dispose('T1 end'); }
  }

  // ================= T2. byte-stable tool registry =================
  {
    const expected = [
      {
        name: 'bash',
        description: 'Execute a command in the local browser Linux-like compatibility runtime. '
          + 'Use it for filesystem work, Python execution, text/data processing, and supported network operations.',
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string', description: 'The shell command to execute.' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
      {
        name: 'cloud_bash',
        description: 'Legacy remote execution fallback (debug/compatibility tool, not a network path). '
          + 'It is currently NOT configured, so calls fail. Ordinary shell and network work uses the local bash tool.',
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string', description: 'The shell command to execute remotely.' } },
          required: ['input'],
          additionalProperties: false,
        },
      },
    ];
    check('T2 AGENT_TOOL_DEFINITIONS is byte-stable (names, copy, schemas)',
      JSON.stringify(AGENT_TOOL_DEFINITIONS) === JSON.stringify(expected),
      JSON.stringify(AGENT_TOOL_DEFINITIONS));
  }

  // ================= T3. user-visible refusals keep their copy =================
  {
    const c = await freshChain('t3');
    try {
      const run = (name, input, extra) => withTimeout(
        executeTool(name, input, c.vfs, Object.assign({ runtimeSession: c.session, telemetry: c.telemetry }, extra)),
        15000, 'T3 ' + name);

      const cloud = await run('cloud_bash', 'echo hi');
      check('T3 the unconfigured cloud_bash keeps its exact copy and FAILS (never a stub success)',
        cloud.success === false && cloud.output === 'Cloud execution is not configured.',
        JSON.stringify(cloud));

      const unknown = await run('no_such_tool', 'echo hi');
      check('T3 the unknown-tool copy keeps the exact registry list and FAILS',
        unknown.success === false
          && unknown.output === 'unknown tool: no_such_tool. Available tools: bash, cloud_bash',
        JSON.stringify(unknown));

      const noSession = await withTimeout(
        executeTool('bash', 'echo hi', c.vfs, { telemetry: c.telemetry }),
        15000, 'T3 no-session');
      check('T3 bash without an injected runtime session fails LOUDLY (assembly-bug path preserved)',
        noSession.success === false
          && noSession.output === 'tool execution failed: bash: no runtime session injected',
        JSON.stringify(noSession));

      check('T3 every refusal was recorded as a telemetry failure',
        c.telemetry.records.length === 3 && c.telemetry.records.every((r) => r.success === false),
        JSON.stringify(c.telemetry.records.map((r) => [r.tool, r.success, r.error])));
    } finally { c.host.dispose('T3 end'); }
  }

  // ================= T4. the page-default telemetry sink =================
  {
    const c = await freshChain('t4');
    try {
      const before = globalThis.Telemetry.records.length;
      await withTimeout(
        executeTool('cloud_bash', 'x', c.vfs, { runtimeSession: c.session }),
        15000, 'T4 default sink');
      const last = globalThis.Telemetry.records[globalThis.Telemetry.records.length - 1];
      check('T4 with no opts.telemetry the record lands in the page Telemetry global (default path preserved)',
        globalThis.Telemetry.records.length === before + 1
          && last && last.tool === 'cloud_bash' && last.success === false,
        JSON.stringify(last || null));
    } finally { c.host.dispose('T4 end'); }
  }

  // ================= MP. the Product policy through the REAL chain =================
  {
    const c = await freshChain('mp');
    try {
      // The extracted runtime keeps the home skeleton the HOST's explicit
      // choice (neutral default when omitted — the pre-switch in-repo VFS
      // pre-built /home/locus). The product store mounts a home provider,
      // so the adapter gate does the same: a REAL writable /home/locus.
      c.vfs.mount('/home/locus', runtimeApi.createMemoryWorkspace({ name: 'home' }), 'read-write');
      const policy = LocusMutationPolicy.create();
      const opts = { runtimeSession: c.session, mutationPolicy: policy, telemetry: c.telemetry };
      // The real skills tree, written through the real shell. NOTE: the
      // extracted runtime's shell has NO mkdir command (the pre-switch
      // in-repo shell did) — the tree is built with redirections only, and
      // the setup itself is ASSERTED so a broken assembly can never hide
      // behind the later policy refusals.
      const setup = await withTimeout(executeTool('bash',
        'echo guidance > /home/locus/.skills/cap-a/synthetic-skill.skill'
        + ' && echo mine > /home/locus/notes.txt && echo other > /tmp/work/other.txt',
        c.vfs, opts), 30000, 'MP setup');
      check('MP0 the setup tree exists through the real chain (mounted home, redirections only)',
        setup.success === true, JSON.stringify(setup));

      const mvOut = await withTimeout(executeTool('bash',
        'mv /home/locus/.skills/cap-a/synthetic-skill.skill /home/locus/renamed.skill', c.vfs, opts),
        15000, 'MP mv-out');
      check('MP1 the mv of a skill instance is refused with the byte-stable identity contract THROUGH the real chain',
        mvOut.success === false
          && mvOut.output === 'mv: /home/locus/.skills/cap-a/synthetic-skill.skill: ' + IDENTITY_MSG,
        JSON.stringify(mvOut));
      check('MP1b nothing was moved',
        (await c.vfs.read('/home/locus/.skills/cap-a/synthetic-skill.skill').catch(() => null)) !== null
          && (await c.vfs.read('/home/locus/renamed.skill').catch(() => null)) === null);

      const mvIn = await withTimeout(executeTool('bash',
        'mv /home/locus/notes.txt /home/locus/.skills/cap-a/incoming.skill', c.vfs, opts),
        15000, 'MP mv-in');
      check('MP2 the mv INTO the skills tree is refused on the destination side, exact copy',
        mvIn.success === false && mvIn.output === 'mv: /home/locus/notes.txt: ' + IDENTITY_MSG,
        JSON.stringify(mvIn));

      const rmDir = await withTimeout(executeTool('bash',
        'rm -r /home/locus/.skills/cap-a', c.vfs, opts), 15000, 'MP rm-dir');
      check('MP3 the rm of a capability directory keeps the exact refusal text',
        rmDir.success === false
          && rmDir.output === 'rm: refusing to remove capability skill directory: /home/locus/.skills/cap-a. ' + IDENTITY_MSG,
        JSON.stringify(rmDir));
      check('MP3b the directory survived with its files',
        (await c.vfs.read('/home/locus/.skills/cap-a/synthetic-skill.skill').catch(() => null)) !== null);

      const ok = await withTimeout(executeTool('bash',
        'mv /home/locus/notes.txt /home/locus/moved-notes.txt && cat /home/locus/moved-notes.txt', c.vfs, opts),
        15000, 'MP ordinary');
      check('MP4 ordinary mutations outside the tree are not over-blocked (the policy is injected, not global)',
        ok.success === true && String(ok.output).includes('mine'),
        JSON.stringify(ok));
    } finally { c.host.dispose('MP end'); }
  }

  // ================= S1. the per-call signal reaches the Runtime =================
  {
    const c = await freshChain('s1');
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      const res = await withTimeout(
        executeTool('bash', 'echo never > /tmp/m3c-a-s1.txt', c.vfs,
          { runtimeSession: c.session, signal: ctrl.signal, telemetry: c.telemetry }),
        15000, 'S1 pre-aborted');
      check('S1 a pre-aborted per-call signal is refused BY THE RUNTIME (its own cancellation text), a failure, zero effect',
        res.success === false
          && res.output === 'tool execution failed: execution cancelled'
          && (await c.vfs.read('/tmp/m3c-a-s1.txt').catch(() => null)) === null
          && c.telemetry.records[c.telemetry.records.length - 1].success === false,
        JSON.stringify({ res, file: await c.vfs.read('/tmp/m3c-a-s1.txt').catch(() => null) }));
    } finally { c.host.dispose('S1 end'); }
  }

  // ================= S2. barrier: caller abort during a parked write =================
  // One command only: the abort lands while the FINAL dispatched write is
  // unsettled, so the session's final classification must DOWNGRADE the
  // otherwise-clean report into an honest failure with the additive note.
  {
    const c = await freshChain('s2');
    const mem = runtimeApi.createMemoryWorkspace({ name: 's2-park' });
    const park = parkProviderWrites(mem, 'm3c-a-dg.txt');
    c.vfs.mount('/mnt/park', mem, 'read-write');
    try {
      const ctrl = new AbortController();
      const settledFlag = { settled: false };
      const pending = executeTool('bash', 'echo one > /mnt/park/m3c-a-dg.txt', c.vfs,
        { runtimeSession: c.session, signal: ctrl.signal, telemetry: c.telemetry });
      pending.then(() => { settledFlag.settled = true; }, () => { settledFlag.settled = true; });
      await waitFor('S2 the real write was dispatched and parked', () => park.entered === 1 && !!park.release);
      ctrl.abort();
      check('S2 the execution did NOT settle before the test released the dispatched write',
        (await stayedUnsettled(settledFlag)) === true,
        JSON.stringify({ settled: settledFlag.settled, park }));
      park.release();
      const res = await withTimeout(pending, 30000, 'S2 settle after release');
      const kept = await c.vfs.read('/mnt/park/m3c-a-dg.txt').catch(() => null);
      check('S2 after release the run is reported FAILED (the clean report was downgraded — never a success)',
        res.success === false
          && String(res.output).startsWith('runtime: execution cancelled — the run was superseded')
          && String(res.output).includes('the settled effect is kept (no rollback)')
          && c.telemetry.records[c.telemetry.records.length - 1].success === false
          && c.telemetry.records[c.telemetry.records.length - 1].error === res.output,
        JSON.stringify({ res, rec: c.telemetry.records[c.telemetry.records.length - 1] }));
      check('S2b the dispatched-and-settled effect is kept (no fake rollback)',
        typeof kept === 'string' && kept.includes('one'), JSON.stringify(String(kept).slice(0, 40)));
      // The SAME session is still reusable for a follow-up tool call.
      const follow = await withTimeout(
        executeTool('bash', 'echo after > /mnt/park/m3c-a-dg-after.txt && cat /mnt/park/m3c-a-dg-after.txt',
          c.vfs, { runtimeSession: c.session, telemetry: c.telemetry }),
        30000, 'S2 follow-up');
      check('S2c the session stays usable after the cancelled execution',
        follow.success === true && String(follow.output).includes('after'), JSON.stringify(follow));
    } finally { park.restore(); c.host.dispose('S2 end'); }
  }

  // ================= S3. barrier: abort stops the CHAIN, later ops never dispatch =================
  {
    const c = await freshChain('s3');
    const mem = runtimeApi.createMemoryWorkspace({ name: 's3-park' });
    const park = parkProviderWrites(mem, 'm3c-a-nd.txt');
    c.vfs.mount('/mnt/park', mem, 'read-write');
    try {
      const ctrl = new AbortController();
      const settledFlag = { settled: false };
      const pending = executeTool('bash',
        'echo one > /mnt/park/m3c-a-nd.txt && echo two > /mnt/park/m3c-a-nd2.txt', c.vfs,
        { runtimeSession: c.session, signal: ctrl.signal, telemetry: c.telemetry });
      pending.then(() => { settledFlag.settled = true; }, () => { settledFlag.settled = true; });
      await waitFor('S3 the first write was dispatched and parked', () => park.entered === 1 && !!park.release);
      ctrl.abort();
      park.release();
      const res = await withTimeout(pending, 30000, 'S3 settle');
      const first = await c.vfs.read('/mnt/park/m3c-a-nd.txt').catch(() => null);
      const second = await c.vfs.read('/mnt/park/m3c-a-nd2.txt').catch(() => null);
      check('S3 the abort mid-chain ends the run as a FAILURE and the next operation is NEVER dispatched',
        res.success === false && park.entered === 1 && second === null,
        JSON.stringify({ res: { success: res.success, output: String(res.output).slice(0, 120) },
          parkEntered: park.entered, second: String(second).slice(0, 30) }));
      check('S3b the already-dispatched first operation is kept honestly (no rollback)',
        typeof first === 'string' && first.includes('one'), JSON.stringify(String(first).slice(0, 40)));
      check('S3c telemetry records the failure (never a success)',
        c.telemetry.records[c.telemetry.records.length - 1].success === false,
        JSON.stringify(c.telemetry.records[c.telemetry.records.length - 1] || null));
    } finally { park.restore(); c.host.dispose('S3 end'); }
  }

  // ================= B1. session boundary mid-write is not masked =================
  {
    const c = await freshChain('b1');
    const mem = runtimeApi.createMemoryWorkspace({ name: 'b1-park' });
    const park = parkProviderWrites(mem, 'm3c-a-b1.txt');
    c.vfs.mount('/mnt/park', mem, 'read-write');
    try {
      const settledFlag = { settled: false };
      const pending = executeTool('bash', 'echo kept > /mnt/park/m3c-a-b1.txt', c.vfs,
        { runtimeSession: c.session, telemetry: c.telemetry });
      pending.then(() => { settledFlag.settled = true; }, () => { settledFlag.settled = true; });
      await waitFor('B1 the real write was dispatched and parked', () => park.entered === 1 && !!park.release);
      c.session.reset('m3c-a boundary'); // the REAL session boundary, caller never aborts
      park.release();
      const res = await withTimeout(pending, 30000, 'B1 settle');
      const kept = await c.vfs.read('/mnt/park/m3c-a-b1.txt').catch(() => null);
      check('B1 the boundary-struck run settles as a FAILURE after release (the tool result never masks it)',
        res.success === false
          && String(res.output).startsWith('runtime: runtime session reset: m3c-a boundary — the run was superseded')
          && String(res.output).includes('the settled effect is kept (no rollback)')
          && c.telemetry.records[c.telemetry.records.length - 1].success === false,
        JSON.stringify({ success: res.success, output: String(res.output).slice(0, 200) }));
      check('B1b the settled effect stays (boundary ≠ rollback), the session is reusable',
        typeof kept === 'string' && kept.includes('kept')
          && (await withTimeout(
            executeTool('bash', 'echo again > /mnt/park/m3c-a-b1-after.txt && cat /mnt/park/m3c-a-b1-after.txt',
              c.vfs, { runtimeSession: c.session, telemetry: c.telemetry }),
            30000, 'B1 follow-up')).success === true,
        JSON.stringify(String(kept).slice(0, 40)));
    } finally { park.restore(); c.host.dispose('B1 end'); }
  }

  // ================= B2. dispose mid-write: refusal stays loud =================
  {
    const c = await freshChain('b2');
    const mem = runtimeApi.createMemoryWorkspace({ name: 'b2-park' });
    const park = parkProviderWrites(mem, 'm3c-a-b2.txt');
    c.vfs.mount('/mnt/park', mem, 'read-write');
    try {
      const pending = executeTool('bash', 'echo kept > /mnt/park/m3c-a-b2.txt', c.vfs,
        { runtimeSession: c.session, telemetry: c.telemetry });
      await waitFor('B2 the real write was dispatched and parked', () => park.entered === 1 && !!park.release);
      c.session.dispose('m3c-a teardown'); // terminal boundary
      park.release();
      const res = await withTimeout(pending, 30000, 'B2 settle');
      const kept = await c.vfs.read('/mnt/park/m3c-a-b2.txt').catch(() => null);
      check('B2 the disposed-session run settles as a FAILURE with the effect kept (never a success)',
        res.success === false && typeof kept === 'string' && kept.includes('kept')
          && c.telemetry.records[c.telemetry.records.length - 1].success === false,
        JSON.stringify({ success: res.success, output: String(res.output).slice(0, 160) }));
      const after = await withTimeout(
        executeTool('bash', 'echo x', c.vfs, { runtimeSession: c.session, telemetry: c.telemetry }),
        15000, 'B2 after-dispose');
      check('B2b the disposed session refuses follow-up work LOUDLY (a failure, not a silent success)',
        after.success === false && String(after.output).includes('disposed'),
        JSON.stringify(after));
    } finally { park.restore(); c.host.dispose('B2 end'); }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });

// Store runtime-session lifecycle wiring tests (M2a, repository split):
// the REAL presentation store (src/ui/store.js) wired to a scripted
// session fake (window.__LOCUS_HOOKS__.sessionFactory — the documented
// injection seam, M3c integration) and a RECORDED runtime session. Proves
// the ownership invariants at the product seam:
//
//   SP1  the store drives the ONE canonical runtime session and task
//        preparation configures IT (prepare with the TaskEnvironment's
//        payload, null payload when there is no capability manager);
//   SP2  shell execution routes through exactly the SAME session in
//        opts.runtimeSession — preparation and execution never split;
//   SP3  the session boundary (newTask / session reset) resets the SAME
//        runtime session via onSessionReset;
//   SP4  the runtime session is resolved lazily (text-only work never
//        touches it) and a deployment without the runtime core resolves
//        to null with no error;
//   SP5  window.__LOCUS_HOOKS__.runtimeSession substitutes the session
//        (test/e2e seam) before first use.
//
// M3c integration dispositions:
//   - SP7 (a missing classic policy script refuses loudly) is RETIRED:
//     with static ESM imports the "mutation-policy.js was never loaded"
//     failure mode is structurally impossible; the loud-refusal guard
//     itself remains in the store's taskMutationPolicy as defense.
//   - The capability-manager fakes (SP8/SP9) became per-scenario method
//     patches on the REAL exported capabilityManager instance (the store
//     resolves refreshSkillPresence/buildTaskEnvironment on it at call
//     time) — no core table exists to swap a fake class into.
//
// Interpreter-instance BEHAVIOR (prepare/reset/dispose/prepare-barrier
// semantics) is pinned in tests/python-lifecycle.test.cjs and
// tests/runtime-session.test.mjs against the REAL factory/entry; REAL
// browser python is gated by the e2e python suites driving the
// production seam.
// Run: node tests/store-python-lifecycle.test.mjs

// M3c integration: the store is a REAL ES module over the two installed
// cores — the graph assembles itself; only the documented hooks seams are
// set (sessionFactory / runtimeSession / runtimeCapabilities /
// toolExecutor), and the store imports the policy, mounts and projector
// itself.
const { executeTool } = await import('../src/tools.js');

// ---------- recorded runtime session ----------
// A fake session faithful to the surface the store uses:
// prepare(req) → { rebuiltInterpreter }, reset(reason), pythonRuntime().
const createdSessions = [];
const fakeInterpreter = () => ({ marker: 'fake-interpreter' });
const makeSession = () => {
  const s = {
    interpreter: fakeInterpreter(),
    prepared: [],
    resets: [],
    prepareGate: null,
    async prepare(req) {
      if (s.prepareGate) await s.prepareGate();
      const wanted = req && req.python ? req.python.key : null;
      s.prepared.push({ key: wanted, python: req ? req.python : undefined, signal: req ? req.signal : undefined });
      return { rebuiltInterpreter: false };
    },
    reset(reason) { s.resets.push(reason ?? null); },
    status() { return { interpreter: 'cold', busyExecutions: 0, extensionKey: null, disposed: null }; },
    onStatus() { return () => {}; },
    pythonRuntime() { return s.interpreter; },
    execute: async () => { throw new Error('fake session: execute not expected in this suite'); },
  };
  createdSessions.push(s);
  return s;
};

// M2c: test hooks must assemble the runtime DECLARATION explicitly (the
// product compatibility check reads it when a session is injected through
// the seam) — the same shape RuntimeHost.capabilities() publishes.
const HOOKS_RUNTIME_DECLARATION = Object.freeze({
  contractVersion: 1,
  executionKinds: ['shell', 'python'],
  bootstrap: { shaPinned: true },
  policyMechanisms: ['mutationPolicy', 'authorization'],
  commands: ['cat', 'echo'],
});
const hooksWith = (session, declaration) => ({
  runtimeSession: session,
  runtimeCapabilities: declaration === undefined ? HOOKS_RUNTIME_DECLARATION : declaration,
  // The scripted AgentSession for the store's session boundary + run
  // counting; production never sets this seam.
  sessionFactory: (deps) => new FakeAgentSession(deps),
  // Record the exact executor opts the store's ToolPort hands out (SP2
  // evidence) and forward to the REAL production executor — the recorded
  // call IS the production routing, not a parallel path.
  toolExecutor: (tool, input, workspace, opts) => {
    toolCalls.push({ tool, input, opts });
    return executeTool(tool, input, workspace, opts);
  },
});

// ---------- the scripted AgentSession (injected via sessionFactory) ----------
class FakeAgentSession {
  constructor(deps) {
    this.emit = deps.emit;
    this.onSessionReset = deps.onSessionReset;
    this.toolPort = deps.toolPort; // the store's product ToolPort (SP2 drives it)
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.script = [];
    this.lastRunOpts = null;
  }
  reset() {
    if (this.task && this.task.controller) this.task.controller.abort();
    this.history = [];
    this.generation++;
    if (this.onSessionReset) this.onSessionReset();
  }
  cancel() { if (this.task && this.task.controller) this.task.controller.abort(); }
  async historyRequestBytes() { return 0; }
  async run(input, opts) {
    if (this.task) throw new Error('AgentSession already has a running task');
    this.ranCount = (this.ranCount || 0) + 1;
    const o = opts || {};
    this.lastRunOpts = o;
    const emit = (o.emit && typeof o.emit === 'function') ? o.emit : this.emit;
    const controller = new AbortController();
    this.task = { controller };
    try {
      emit({ type: 'task_start', input });
      for (const step of this.script) {
        if (typeof step === 'function') await step(controller, this);
        else emit(step);
      }
    } finally {
      if (this.task && this.task.controller === controller) this.task = null;
    }
  }
}

// Records the opts the store hands to every tool call (SP2 evidence —
// captured in the hooks.toolExecutor seam above, which forwards to the
// REAL production executor).
const toolCalls = [];

// ---------- gated capability manager (prepare-phase liveness, M1b fix) ----
// Refreshes can hang (durability re-observation): these sections park a
// REAL submit() inside refreshSkillPresence and prove the stale task never
// prepares/resets/reconfigures the canonical runtime session afterwards.
// M3c integration: the fake CLASS became per-scenario method patches on
// the REAL exported capabilityManager instance (patchCapabilityManager
// below) — the store resolves the methods on the instance at call time.
function patchCapabilityManager(cm) {
  const realRefresh = cm.refreshSkillPresence;
  const realBuild = cm.buildTaskEnvironment;
  const rec = { refreshes: 0, envBuilt: 0, release: null };
  cm.refreshSkillPresence = async () => {
    rec.refreshes++;
    await new Promise((r) => { rec.release = r; });
  };
  cm.buildTaskEnvironment = (...args) => { rec.envBuilt++; return realBuild.apply(cm, args); };
  rec.restore = () => {
    cm.refreshSkillPresence = realRefresh;
    cm.buildTaskEnvironment = realBuild;
  };
  return rec;
}

// The canonical runtime session for THIS module graph, injected through the
// hooks seam BEFORE the store resolves it (the exact production seam).
const canonical = makeSession();
globalThis.window = {
  location: { protocol: 'https:' },
  __LOCUS_HOOKS__: hooksWith(canonical),
};

// Every graph below shares THIS process's persistence singleton (memory
// mode). A graph's boot restores conversations SAVED BY EARLIER GRAPHS and
// the harness restoreInto() then resets the fresh session — node-suite
// contamination a real page never sees. Wipe the store before each graph.
const { PersistenceServiceInstance } = await import('../src/persistence.js');
async function freshGraph(specifier) {
  await PersistenceServiceInstance.reset();
  return import(specifier);
}
const ui = await import('../src/ui/store.js');
const { store, session, submit, newTask, whenBooted } = ui;
// Boot settles asynchronously (durable restore replaces the conversations
// array) — capture state only after it.
await whenBooted;

// M2b: the suite seeds the declared harness core table with its fakes
// (the same rule a classic page follows). The FakeAgentSession is the
// AgentSession the entry hands to the store. Review F1: the host provides
// the capability-composition core fakes TOO (FakeCapabilityManager below),
// so the REAL harnessCapabilities() declares capabilityComposition — the
// (The legacy __LOCUS_HARNESS_CORE__ host table is gone in the three-repo
// world: the store imports the REAL harness session factory, catalogs and
// validators through the transfer layer, and the scripted session enters
// through the hooks.sessionFactory seam above. The REAL
// harnessCapabilities() declares capabilityComposition — the product's
// declared degrade (skip capability work) must NOT fire.)

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runScript = (script) => { session.script = script; };
// M3c integration: wait for the parked STATE, never a fixed yield.
async function waitFor(cond, label, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + label);
    await sleep(5);
  }
}

check('SP0 the store resolved exactly the injected session (no second construction)',
  ui.runtimeSession() === canonical && createdSessions.length === 1,
  JSON.stringify({ sessions: createdSessions.length }));

// ---------- SP4: lazy resolution (already proven by order) ----------
// The session must not have been touched before the first explicit use OR
// the first task — both happened below; a second submit reuses the SAME
// session (never a second resolution).
const createdBefore = createdSessions.length;

// ---------- SP1 + SP2 + SP3: one task end to end ----------
{
  // session.toolPort IS the store's product ToolPort (the exact
  // function the real agent loop invokes for every tool call).
  await session.toolPort.execute({ name: 'bash', input: 'echo probe', context: { filesystem: ui.vfs, signal: new AbortController().signal } });
  const done = submit('run python and report');
  await done;
  check('SP1 task preparation configured the CANONICAL runtime session',
    canonical.prepared.length === 1
      && canonical.prepared[0].key === null
      && canonical.prepared[0].python === null,
    JSON.stringify(canonical.prepared));
  check('SP2 the tool executor routed through the SAME session in opts.runtimeSession',
    toolCalls.length >= 1
      && toolCalls.every((c) => c.opts && c.opts.runtimeSession === canonical),
    JSON.stringify(toolCalls.map((c) => c.opts && (c.opts.runtimeSession === canonical))));
  check('SP2b no interpreter instance leaked into the tool opts (the session owns it)',
    toolCalls.every((c) => c.opts && c.opts.pythonRuntime === undefined && c.opts.grepWorkerSource === undefined),
    JSON.stringify(toolCalls.map((c) => Object.keys(c.opts || {}))));
  check('SP2c no additional session was resolved for execution',
    createdSessions.length === createdBefore,
    JSON.stringify({ created: createdSessions.length, before: createdBefore }));

  // SP3: the session boundary resets the canonical runtime session.
  const resetsBefore = canonical.resets.length;
  newTask();
  check('SP3 the session boundary reset the CANONICAL runtime session',
    canonical.resets.length === resetsBefore + 1,
    JSON.stringify(canonical.resets));
}

// ---------- SP1b: a second task reuses the session (same key, no reset) ----------
{
  runScript([]);
  await submit('second task');
  check('SP1b the second task reused the SAME session (no reconfiguration churn)',
    canonical.prepared.length === 2
      && canonical.prepared[1].key === null
      && canonical.prepared[1].python === null
      && createdSessions.length === 1,
    JSON.stringify({ prepared: canonical.prepared.length, created: createdSessions.length }));
}

// ---------- SP6: the product mutation policy rides every bash call -------
{
  toolCalls.length = 0;
  await session.toolPort.execute({ name: 'bash', input: 'mv /home/locus/.skills/x /tmp/x', context: { filesystem: ui.vfs, signal: new AbortController().signal } });
  const injected = toolCalls[0] && toolCalls[0].opts && toolCalls[0].opts.mutationPolicy;
  check('SP6 the executor opts carry a REAL product mutation policy',
    !!injected && typeof injected.checkMove === 'function' && typeof injected.checkRemove === 'function'
      && typeof injected.isPolicyRefusal === 'function',
    JSON.stringify({ present: !!injected }));
  const refusal = injected.checkMove({
    source: '/home/locus/.skills/cap-a/synthetic-skill.skill',
    destination: '/home/locus/renamed.skill',
    recursive: true,
  });
  const allowed = injected.checkMove({ source: '/tmp/a.txt', destination: '/tmp/b.txt', recursive: true });
  check('SP6b the injected policy enforces the skill identity and nothing else',
    refusal.allowed === false && refusal.reason.includes('Skill instance paths are stable')
      && allowed.allowed === true,
    JSON.stringify({ refusal, allowed }));
  // SP6c: the executor opts carry the execution authorization PORT, and it
  // forwards the plain request PLUS the product-side identity to the
  // approval controller (contract §3.5 direction).
  const authorization = toolCalls[0] && toolCalls[0].opts && toolCalls[0].opts.authorization;
  check('SP6c the executor opts carry an execution authorization port',
    !!authorization && typeof authorization.request === 'function',
    JSON.stringify({ present: !!authorization }));
}

// ---------- SP5: a fresh graph substitutes its own session ----------
{
  // Fresh module graph: hooks must be set BEFORE the first resolution of
  // that graph. Use a query string so the store module re-evaluates.
  const hookedSession = makeSession();
  globalThis.window = {
    location: { protocol: 'https:' },
    __LOCUS_HOOKS__: hooksWith(hookedSession),
  };
  const ui2 = await freshGraph('../src/ui/store.js?hooks-seam');
  const resolved = ui2.runtimeSession();
  check('SP5 window.__LOCUS_HOOKS__.runtimeSession substitutes the session',
    resolved === hookedSession && typeof resolved.prepare === 'function'
      && ui2.pythonRuntime() === hookedSession.interpreter,
    JSON.stringify({ resolved: resolved === hookedSession }));
  delete globalThis.window;
}

// (SP7 — "a missing classic policy script refuses loudly" — RETIRED at
// M3c integration: mutation-policy.js is a static ESM import now, so the
// script-order failure mode it guarded cannot occur. The loud-refusal
// guard itself remains in the store's taskMutationPolicy as defense.)

// ---------- SP8: cancel while refreshSkillPresence hangs ----------
// The task is cancelled DURING the async capability refresh (before any
// interpreter preparation): once the refresh returns, the stale task must
// not prepare/reset/reconfigure the canonical runtime session and must not
// reach the model. The runner's own guards catch it; the Product must not
// hand the cancelled task's configuration work to the runtime at all.
{
  const s8 = makeSession();
  globalThis.window = {
    location: { protocol: 'https:' },
    __LOCUS_HOOKS__: hooksWith(s8),
  };
  const ui8 = await freshGraph('../src/ui/store.js?presence-cancel');
  const rec8 = patchCapabilityManager(ui8.capabilityManager);
  const done8 = ui8.submit('presence cancel task');
  await waitFor(() => !!rec8.release, 'SP8 park');
  check('SP8 the task is parked inside refreshSkillPresence',
    rec8.refreshes === 1 && !!rec8.release, JSON.stringify({ refreshes: rec8.refreshes }));
  ui8.cancelTask();
  rec8.release();
  await done8;
  check('SP8b the cancelled task never prepared the canonical runtime session',
    s8.prepared.length === 0, JSON.stringify({ prepared: s8.prepared.length }));
  check('SP8c no TaskEnvironment was built for the cancelled task',
    rec8.envBuilt === 0, JSON.stringify({ envBuilt: rec8.envBuilt }));
  check('SP8d no model request was made for the cancelled task',
    (ui8.session.ranCount || 0) === 0, JSON.stringify({ ran: ui8.session.ranCount }));
  rec8.restore(); // the follow-up must run the REAL manager again
  const followUp8 = ui8.submit('follow-up after cancel');
  check('SP8e the cancelled task ended and admission reopened',
    ui8.store.busy === false && !!followUp8, JSON.stringify({ busy: ui8.store.busy }));
  await followUp8;
}

// ---------- SP9: session boundary while refreshSkillPresence hangs ----------
{
  const s9 = makeSession();
  globalThis.window = {
    location: { protocol: 'https:' },
    __LOCUS_HOOKS__: hooksWith(s9),
  };
  const ui9 = await freshGraph('../src/ui/store.js?presence-boundary');
  const rec9 = patchCapabilityManager(ui9.capabilityManager);
  const done9 = ui9.submit('presence boundary task');
  await waitFor(() => !!rec9.release, 'SP9 park');
  ui9.newTask();          // the session boundary lands mid-refresh
  rec9.release();
  await done9;
  check('SP9 the boundary-struck task stops cold: no environment, no model',
    rec9.envBuilt === 0 && (ui9.session.ranCount || 0) === 0,
    JSON.stringify({ envBuilt: rec9.envBuilt, ran: ui9.session.ranCount }));
  check('SP9b the stale task neither prepared the session nor reset it again (the boundary owns the one reset)',
    s9.prepared.length === 0 && s9.resets.length === 1,
    JSON.stringify({ prepared: s9.prepared.length, resets: s9.resets.length }));
  check('SP9c the stale task ended and admission reopened',
    ui9.store.busy === false, JSON.stringify({ busy: ui9.store.busy }));
}

// ---------- SP10: normal flow still prepares — with the task signal ----------
{
  const s10 = makeSession();
  globalThis.window = { location: { protocol: 'https:' }, __LOCUS_HOOKS__: hooksWith(s10) };
  const ui10 = await freshGraph('../src/ui/store.js?presence-normal');
  const cm10 = ui10.capabilityManager;
  const done10 = ui10.submit('normal presence task');
  await done10;
  check('SP10 a live task hands its OWN signal to the session prepare',
    s10.prepared.length === 1 && !!s10.prepared[0].signal
      && s10.prepared[0].signal.aborted === false,
    JSON.stringify({ prepared: s10.prepared.length, signal: !!(s10.prepared[0] && s10.prepared[0].signal) }));
  check('SP10b the model ran exactly once for the normal task',
    ui10.session.ranCount === 1, JSON.stringify({ ran: ui10.session.ranCount }));
  const done10b = ui10.submit('second normal task');
  await done10b;
  check('SP10c same-key tasks cause no interpreter churn (prepare only, zero resets)',
    s10.prepared.length === 2 && s10.resets.length === 0,
    JSON.stringify({ prepared: s10.prepared.length, resets: s10.resets.length }));
}

// ---------- SP11: the compatibility gate requires an explicit declaration --
// M2c: a hooks-injected session WITHOUT an assembled declaration (or with
// an unsupported one) must reject every task through the REAL product entry
// — an absent declaration is never defaulted to compatible.
{
  const s11 = makeSession();
  globalThis.window = {
    location: { protocol: 'https:' },
    __LOCUS_HOOKS__: { runtimeSession: s11, sessionFactory: (deps) => new FakeAgentSession(deps) },
  }; // no runtime declaration
  const ui11 = await freshGraph('../src/ui/store.js?compat-no-decl');
  const done11 = ui11.submit('no declaration task');
  await done11;
  const evts11 = ui11.store.conversations.flatMap((c) => c.items);
  check('SP11 a session without a declaration rejects tasks (declaration_missing)',
    (ui11.session.ranCount || 0) === 0
      && s11.prepared.length === 0
      && evts11.some((i) => i.kind === 'error' && String(i.code) === 'core_incompatible'),
    JSON.stringify({ ran: ui11.session.ranCount || 0, prepared: s11.prepared.length,
      codes: evts11.map((i) => i.kind + ':' + i.code) }));

  const s11b = makeSession();
  globalThis.window = {
    location: { protocol: 'https:' },
    __LOCUS_HOOKS__: hooksWith(s11b, Object.freeze({
      contractVersion: 999,
      executionKinds: ['shell', 'python'],
      bootstrap: { shaPinned: true },
      policyMechanisms: ['mutationPolicy', 'authorization'],
      commands: ['echo'],
    })),
  };
  const ui11b = await freshGraph('../src/ui/store.js?compat-bad-version');
  const done11b = ui11b.submit('bad version task');
  await done11b;
  const evts11b = ui11b.store.conversations.flatMap((c) => c.items);
  check('SP11b an unsupported runtime contract version rejects the task before any model request',
    (ui11b.session.ranCount || 0) === 0 && s11b.prepared.length === 0
      && evts11b.some((i) => i.kind === 'error' && String(i.code) === 'core_incompatible'
        && String(i.message || '').includes('999')),
    JSON.stringify({ ran: ui11b.session.ranCount || 0,
      msgs: evts11b.map((i) => (i.message || '').slice(0, 120)) }));
  // The slot is released: the next (legal) task is admitted.
  globalThis.window = { location: { protocol: 'https:' }, __LOCUS_HOOKS__: hooksWith(s11b) };
  const follow11b = await freshGraph('../src/ui/store.js?compat-recovery');
  const done11c = follow11b.submit('legal follow-up');
  check('SP11c the slot was released and the next legal task is admitted', !!done11c);
  await done11c;
  check('SP11d the legal task ran on the same (now compatible) session',
    follow11b.session.ranCount === 1, JSON.stringify({ ran: follow11b.session.ranCount }));
}

// The hooks window is section-local: remove it so nothing after this
// file's sections observes an injected session by accident.
delete globalThis.window;

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

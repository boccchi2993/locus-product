// Submit/presentation wiring regressions (node, no DOM):
// exercise the real store with a persistence seam so normal task_start
// ownership and pre-run terminal fallbacks are tested at their actual await
// boundaries.
//
// M3c integration: the store is a REAL ES module over the two installed
// cores. The scripted session is injected through the documented
// window.__LOCUS_HOOKS__.sessionFactory seam (production never sets it);
// the persistence gate/record seams below PATCH the canonical
// PersistenceServiceInstance's per-call methods (the store resolves them
// on the instance at call time) — no global persistence handle exists
// anymore to swap.

class FakeAgentSession {
  constructor(deps) {
    this.emit = deps.emit;
    this.onSessionReset = deps.onSessionReset;
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.script = [];
    this.runCalls = 0;
  }

  reset() {
    if (this.task) this.task.controller.abort();
    this.history = [];
    this.generation++;
    if (this.onSessionReset) this.onSessionReset();
  }

  cancel() { if (this.task) this.task.controller.abort(); }

  async historyRequestBytes() { return 0; }

  async run(input, opts) {
    if (this.task) throw new Error('AgentSession already has a running task');
    this.runCalls++;
    // Mirror the real AgentSession seam (M1a lifecycle fix): the task-bound
    // emit sink from the harness runner's ctx wins; the sink is recorded so
    // tests can drive an already-ended task's entry point (late tails).
    const o = opts || {};
    const emit = (o.emit && typeof o.emit === 'function') ? o.emit : this.emit;
    this.lastRunEmit = emit;
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

globalThis.window = {
  location: { protocol: 'https:' },
  __LOCUS_HOOKS__: { sessionFactory: (deps) => new FakeAgentSession(deps) },
};
const ui = await import('../src/ui/store.js');
const { store, session, submit, newTask, cancelTask, whenBooted } = ui;
// Boot settles asynchronously (durable restore replaces the conversations
// array with the loaded rows) — capture state only after it.
await whenBooted;

const providerSessions = new Map();
const presentationEvents = [];
let loadProviderSession = async () => null;
// Patch the canonical singleton's per-call methods: the load goes through
// the suite's gate hook (C/D/E/F park or fail the prepare exactly there);
// presentation events are recorded for the task_start ownership checks.
const { PersistenceServiceInstance } = await import('../src/persistence.js');
PersistenceServiceInstance.loadProviderSession = (conversationId) => loadProviderSession(conversationId);
PersistenceServiceInstance.appendPresentationEvent = async (conversationId, sequence, event) => {
  presentationEvents.push({ conversationId, sequence, event });
  return event;
};

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

const live = () => store.conversations.find((c) => c.id === store.liveConversationId);
const userItems = (conv, content) => conv.items.filter((item) =>
  item.kind === 'user' && (content === undefined || item.content === content));
const taskStarts = (conversationId, input) => presentationEvents.filter((row) =>
  row.conversationId === conversationId && row.event.type === 'task_start'
  && (input === undefined || row.event.input === input));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A. Normal first submit: AgentSession owns the only task_start.
{
  const conv = live();
  session.script = [
    { type: 'assistant_text', content: 'hello back' },
    { type: 'task_end', reason: 'completed' },
  ];
  await submit('hello');
  check('A1 first submit projects user message exactly once', userItems(conv, 'hello').length === 1,
    JSON.stringify(conv.items));
  check('A2 first submit keeps assistant completion', conv.items.some((item) => item.kind === 'assistant')
    && conv.status === 'completed');
  check('A3 normal task_start is owned by AgentSession', taskStarts(conv.id, 'hello').length === 1);
}

// B. Repeated equal content is legal and must not be deduplicated.
{
  const conv = live();
  session.script = [{ type: 'assistant_text', content: 'same answer' }, { type: 'task_end', reason: 'completed' }];
  await submit('same');
  await submit('same');
  check('B1 repeated equal submissions remain two user items', userItems(conv, 'same').length === 2,
    JSON.stringify(conv.items));
  check('B2 repeated equal submissions each persist one task_start', taskStarts(conv.id, 'same').length === 2);
}

// C. Cancellation while persistence is still pre-run preserves intent once.
{
  newTask();
  const conv = live();
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  loadProviderSession = async () => { markStarted(); await gate; return null; };
  const runsBefore = session.runCalls;
  const p = submit('cancel me');
  await started;
  cancelTask();
  release();
  await p;
  check('C1 pre-run cancellation preserves user intent once', userItems(conv, 'cancel me').length === 1,
    JSON.stringify(conv.items));
  check('C2 pre-run cancellation ends cancelled without provider run', conv.status === 'cancelled'
    && session.runCalls === runsBefore);
  check('C3 pre-run cancellation emits one synthetic task_start', taskStarts(conv.id, 'cancel me').length === 1);
  loadProviderSession = async () => null;
}

// D. A session boundary before run() preserves intent in the old conversation only.
{
  newTask();
  const conv = live();
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  loadProviderSession = async () => { markStarted(); await gate; return null; };
  const runsBefore = session.runCalls;
  const p = submit('old task');
  await started;
  newTask();
  const next = live();
  release();
  await p;
  check('D1 pre-run session switch preserves old user intent once', userItems(conv, 'old task').length === 1,
    JSON.stringify(conv.items));
  check('D2 pre-run session switch records terminal reason', conv.status === 'session_changed');
  check('D3 switched conversation receives no old input', userItems(next, 'old task').length === 0
    && session.runCalls === runsBefore);
  check('D4 pre-run session switch emits one synthetic task_start', taskStarts(conv.id, 'old task').length === 1);
  loadProviderSession = async () => null;
}

// E. Persistence rejection before run() keeps the existing catch fallback singular.
{
  newTask();
  const conv = live();
  const runsBefore = session.runCalls;
  loadProviderSession = async () => {
    throw Object.assign(new Error('simulated persistence failure'), { persistenceFailure: true });
  };
  await submit('persist fail');
  check('E1 pre-run persistence failure preserves user intent once', userItems(conv, 'persist fail').length === 1,
    JSON.stringify(conv.items));
  check('E2 pre-run persistence failure keeps terminal semantics', conv.status === 'persistence_error'
    && conv.items.filter((item) => item.kind === 'error' && item.code === 'persistence_write_failed').length === 1);
  check('E3 pre-run persistence failure sends no provider request', session.runCalls === runsBefore);
  loadProviderSession = async () => null;
}

// F. Required persistence failure vs a concurrent cancel: ONE classification
//    table (F4). The Product reports the failure STRUCTURED from the real
//    prepareTask catch; the runner must not downgrade it to cancelled.
{
  newTask();
  const conv = live();
  const runsBefore = session.runCalls;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  loadProviderSession = async () => {
    markStarted();
    await gate;
    throw Object.assign(new Error('simulated required write failure'), { persistenceFailure: true });
  };
  const p = submit('persist fail vs cancel');
  await started;
  cancelTask(); // user cancels while the required write is still in flight
  release();
  await p;
  check('F1 required write failure is NOT downgraded by the concurrent cancel',
    conv.status === 'persistence_error', conv.status);
  check('F2 exactly one persistence_write_failed error is surfaced',
    conv.items.filter((item) => item.kind === 'error' && item.code === 'persistence_write_failed').length === 1,
    JSON.stringify(conv.items.map((i) => i.kind + ':' + (i.code || ''))));
  check('F3 no provider request was sent', session.runCalls === runsBefore);
  loadProviderSession = async () => null;
}

// G. A late tail of an ENDED task cannot pollute the next task while it is
//    still preparing (F2, Product routing level — the filter runs BEFORE
//    any projection).
{
  newTask();
  const convA = live();
  session.script = [
    { type: 'assistant_text', content: 'tail source final' },
    { type: 'task_end', reason: 'completed' },
  ];
  await submit('tail source A');
  const staleEmit = session.lastRunEmit; // the ended task's task-bound sink
  newTask();
  const convB = live();
  check('G0 stale sink captured and conversations differ',
    typeof staleEmit === 'function' && convA.id !== convB.id);
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  loadProviderSession = async () => { markStarted(); await gate; return null; };
  const p = submit('B while stale tails fly');
  await started; // B is PREPARING (parked at the persistence gate)
  staleEmit({ type: 'task_start', input: 'late restart' });
  staleEmit({ type: 'tool_result', tool: 'bash', success: true, output: 'STALE' });
  staleEmit({ type: 'warning', code: 'late_warning', message: 'stale' });
  staleEmit({ type: 'task_end', reason: 'completed' });
  await sleep(10);
  check('G1 B conversation untouched by the stale tail while preparing',
    convB.items.length === 0, JSON.stringify(convB.items));
  check('G2 busy still held for the preparing task', store.busy === true);
  release();
  await p;
  check('G3 B completes with only its own projected events',
    userItems(convB, 'B while stale tails fly').length === 1
    && !JSON.stringify(convB.items).includes('STALE')
    && convB.status === 'completed', JSON.stringify(convB.items));
  loadProviderSession = async () => null;
}

console.log('---');
console.log('submit-presentation.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

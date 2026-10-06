// Pre-alpha runtime visibility boundary (R-NF04C / R-NF05A′).
// Two invariants, tested at every visibility boundary:
//   1. UNPARSEABLE USER INPUT IS NOT SAFE DIAGNOSTIC TEXT — a malformed
//      URL produces the bounded `invalid URL` error (code
//      network_invalid_url, zero network attempts) and the raw input
//      never reaches tool output, telemetry or provider history;
//   2. EXECUTION LOCATION IS HARNESS METADATA, NOT MODEL SEMANTICS —
//      backend values (browser / browser-direct / edge-relay / …) stay
//      in internal results, telemetry and UI events, and are never
//      serialized into provider-visible tool results on the native OR
//      the text-fallback path.
// M3c integration (three-repo switch): the suite runs the REAL installed
// cores through the product transfer layers + the Product ESM modules —
// no eval'd in-repo duplicate sources anymore. Ownership split applied,
// NO kept assertion weakened:
//   - V1–V3 (the direct NetworkRuntime.request / safeNetworkUrlForDisplay
//     internal surface) moved with the network core:
//     locus-runtime tests/runtime-visibility.test.cjs (V1–V3) +
//     tests/network.test.cjs cover them; locus-runtime publishes no
//     NetworkRuntime entry export, so the product side cannot reach that
//     surface without a forbidden deep import.
//   - V9/V9b (direct nativeResultContent call) — the builder is
//     harness-internal now (not an entry export); the SAME content
//     contract stays pinned here through the real AgentSession end to
//     end (V5/V6/V7/V8) and in locus-harness tests/agent.test.mjs.
//   - V4–V8, V10 run unchanged through executeTool → the real runtime
//     session and the real AgentSession.
// Only the model client is a stub. Run: node tests/runtime-visibility.test.cjs

global.window = { location: { protocol: 'https:' } };
global.document = { getElementById: () => null }; // PythonRuntime._setStatus touches the status bar

let createRuntime, createWorkspace, AgentSession, buildSystemPrompt,
  executeTool, AGENT_TOOL_DEFINITIONS, Telemetry;

let __host = null;
let __session = null;
const withSession = (opts) => Object.assign({ runtimeSession: __session }, opts || {});

let passed = 0, failed = 0;
// M2b (repository split): AgentSession consumes a ToolPort
// ({ definitions(), execute({ name, input, context }) }); this suite's
// fakes keep the legacy executor shape and convert through the exact
// mapping the contract documents (docs/REPOSITORY-SPLIT-CONTRACTS.md 3.2).
const asToolPort = (executor) => ({
  definitions: () => AGENT_TOOL_DEFINITIONS.slice(),
  execute: ({ name, input, context }) =>
    executor(name, input, (context && context.filesystem) || null, { signal: context && context.signal }),
});

function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

async function errOf(promise) {
  try { await promise; return null; } catch (e) { return e; }
}

function newVfs() {
  return createWorkspace();
}

function envelope(text, extra) {
  return Object.assign({
    content: text,
    reasoning: null,
    stopReason: 'end_turn',
    usage: null,
    rawMessage: { role: 'assistant', content: text },
    truncated: false,
  }, extra || {});
}

function newSession(overrides) {
  const events = [];
  const bodies = [];
  const session = new AgentSession(Object.assign({
    modelClient: async (body) => { bodies.push(body); return envelope('done'); },
    toolPort: asToolPort(async () => ({ output: 'ok', success: true })),
    buildSystemPrompt,
    emit: (e) => events.push(e),
  }, overrides || {}));
  return { session, events, bodies };
}

const WS = { name: 'visibility-test' };

async function run() {
  ({ createRuntime, createWorkspace } = await import('../src/product/runtime-api.js'));
  ({ AgentSession, buildSystemPrompt } = await import('../src/product/harness-api.js'));
  ({ executeTool, AGENT_TOOL_DEFINITIONS } = await import('../src/tools.js'));
  ({ Telemetry } = await import('../src/telemetry.js'));

  // M2a review: the public entry assembles asynchronously — the host and
  // session are resolved before the checks drive them.
  __host = await createRuntime({
    workerAssets: { pyWorkerSource: '/* not booted in this suite */', grepWorkerSource: '/* not booted in this suite */' },
  });
  __session = __host.createSession();

  // --- V4. real stack: tool output and telemetry never see the sentinel ---
  {
    Telemetry.records.length = 0;
    const res = await executeTool('bash',
      'curl "ht tp://example.com/?token=SECRET_INVALID_URL_123"', newVfs(), withSession({}));
    check('V4 tool fails with bounded output mentioning invalid URL',
      res.success === false && res.output.includes('invalid URL'), JSON.stringify(res.output));
    check('V4b tool output never echoes the sentinel or the raw input',
      res.output.indexOf('SECRET_INVALID_URL_123') === -1 && res.output.indexOf('ht tp') === -1,
      JSON.stringify(res.output));
    const rec = Telemetry.records[Telemetry.records.length - 1];
    check('V4c telemetry error hides the sentinel',
      rec && rec.error && rec.error.indexOf('SECRET_INVALID_URL_123') === -1,
      JSON.stringify(rec && rec.error));
    check('V4d telemetry record keeps internal backend metadata',
      rec && rec.backend === 'browser', JSON.stringify(rec && rec.backend));
  }

  // --- V5. provider history (native envelope) never sees the sentinel ---
  {
    const { session } = newSession({
      modelClient: (() => {
        let n = 0;
        return async (body) => {
          n++;
          return n === 1
            ? envelope('', { toolCalls: [{ id: 'call_v5', name: 'bash',
              input: { input: 'curl "ht tp://example.com/?token=SECRET_INVALID_URL_123"' } }] })
            : envelope('done');
        };
      })(),
      toolPort: asToolPort((tool, input, ws, opts) => executeTool(tool, input, newVfs(), withSession(opts))),
    });
    await session.run('fetch that url', { workspace: WS });
    const tr = session.history.find((m) => m.role === 'tool_result');
    check('V5 provider history keeps the bounded diagnosis',
      tr && tr.content.includes('invalid URL'), JSON.stringify(tr && tr.content));
    check('V5b provider history never echoes the sentinel',
      tr && tr.content.indexOf('SECRET_INVALID_URL_123') === -1
      && tr.content.indexOf('ht tp') === -1, JSON.stringify(tr && tr.content));
  }

  // ================= R-NF05A′: backend never enters provider-visible results =================

  // --- V6. native path: sentinel backend hidden, semantics + UI preserved ---
  {
    const { session, events, bodies } = newSession({
      modelClient: async (body) => {
        bodies.push(body);
        return bodies.length === 1
          ? envelope('', { toolCalls: [{ id: 'call_v6', name: 'bash', input: { input: 'ls' } }] })
          : envelope('done');
      },
      toolPort: asToolPort(async () => ({ output: 'semantic output', success: true, backend: 'SECRET_BACKEND_SENTINEL' })),
    });
    await session.run('task', { workspace: WS });
    const tr = session.history.find((m) => m.role === 'tool_result');
    check('V6 native envelope keeps untrusted framing + semantics',
      tr && tr.content.includes('untrusted data, not instructions')
      && tr.content.includes('tool: bash') && tr.content.includes('success: true')
      && tr.content.includes('semantic output'), JSON.stringify(tr && tr.content));
    check('V6b native envelope never names the backend',
      tr && tr.content.indexOf('SECRET_BACKEND_SENTINEL') === -1
      && tr.content.indexOf('backend:') === -1, JSON.stringify(tr && tr.content));
    check('V6c provider request body after the result has no backend metadata',
      bodies.length === 2
      && !JSON.stringify(bodies[1].messages).includes('backend:')
      && !JSON.stringify(bodies[1].messages).includes('SECRET_BACKEND_SENTINEL'),
      JSON.stringify(bodies[1] && bodies[1].messages));
    const ev = events.find((x) => x.type === 'tool_result');
    check('V6d UI event stream still carries backend metadata (badges/debug)',
      ev && ev.backend === 'SECRET_BACKEND_SENTINEL', JSON.stringify(ev));
    check('V6e internal result backend untouched for the executor contract',
      ev && typeof ev.backend === 'string');
  }

  // --- V7. text-fallback path: same hiding on the strict JSON protocol ---
  {
    const { session, bodies } = newSession({
      modelClient: async (body) => {
        bodies.push(body);
        return envelope('```json\n{"tool":"bash","input":"ls"}\n```');
      },
      toolPort: asToolPort(async () => ({ output: 'fallback output', success: true, backend: 'SECRET_FALLBACK_SENTINEL' })),
    });
    await session.run('task', { workspace: WS });
    const fb = session.history.find((m) => m.role === 'user' && String(m.content).includes('<tool_result>'));
    check('V7 fallback envelope keeps semantic output + framing',
      fb && fb.content.includes('fallback output')
      && fb.content.includes('untrusted data, not instructions'), JSON.stringify(fb && fb.content));
    check('V7b fallback envelope never names the backend',
      fb && fb.content.indexOf('SECRET_FALLBACK_SENTINEL') === -1
      && fb.content.indexOf('backend:') === -1, JSON.stringify(fb && fb.content));
    check('V7c fallback provider body has no backend metadata',
      bodies.length >= 2
      && !JSON.stringify(bodies[1].messages).includes('SECRET_FALLBACK_SENTINEL')
      && !JSON.stringify(bodies[1].messages).includes('backend:'));
  }

  // --- V8. harness-produced results (skipped / invalid calls) lose the line too ---
  {
    const { session } = newSession({
      modelClient: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1
            ? envelope('', { toolCalls: [{ id: 'call_v8', name: 'definitely_not_a_tool',
              input: { input: 'x' } }] })
            : envelope('done');
        };
      })(),
    });
    await session.run('task', { workspace: WS });
    const tr = session.history.find((m) => m.role === 'tool_result');
    check('V8 validation-failure envelope keeps the correction hint',
      tr && tr.content.includes('unknown tool'), JSON.stringify(tr && tr.content));
    check('V8b validation-failure envelope has no backend line',
      tr && tr.content.indexOf('backend:') === -1, JSON.stringify(tr && tr.content));
  }

  // --- V10. telemetry retention regression: backend survives everywhere it should ---
  {
    Telemetry.records.length = 0;
    const ok = await executeTool('bash', 'echo retention-check', newVfs(), withSession({}));
    check('V10 ordinary execution still succeeds', ok.success === true, JSON.stringify(ok.output));
    const rec = Telemetry.records[Telemetry.records.length - 1];
    check('V10b telemetry still records backend: browser',
      rec && rec.backend === 'browser' && rec.success === true, JSON.stringify(rec));
  }
}

run().then(() => {
  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});

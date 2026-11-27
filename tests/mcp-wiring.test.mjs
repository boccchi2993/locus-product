// C3 phase-2 MCP WIRING e2e (node, REAL runtime, NO DOM):
// the full product chain an `mcp` command takes —
//
//   createLocusToolPort (src/product/tool-adapter.js: deps.mcp) →
//   executeTool (src/tools.js: context.mcp) → REAL RuntimeSession.execute
//   (locus-runtime, ctx.mcp) → shell `mcp` → runMcp → the MCP task client
//   → the PRODUCT port (src/product/mcp-port.js) →
//   the connection service + manager states + the ApprovalController
//   'elicitation' kind → back over the wire.
//
//   MW1  `mcp servers` lists the connected server from the task snapshot;
//        the connect path wrote the record and flipped the state with
//        ZERO network traffic (strict stub counts every request)
//   MW2  the handshake walks the REAL wire: initialize → notification
//        carries the negotiated protocol-version header AND the issued
//        session id (the runtime fix this integration locks)
//   MW3  `mcp call` over an SSE stream with a mid-stream form: the port's
//        elicitation kind suspends, the accept decision posts the reply
//        with the SERVER's request id, the same call finishes
//   MW4  the TEST token never appears in any model-visible output
//   MW5  task end: disposeMcpTaskClient(port) — the SAME port object —
//        sends exactly one DELETE; a second call adds none
//   MW6  the port refuses to write a fourth harness state; legacy
//        no-endpoint entries are unavailable and never connectable
//
// The MCP server is a strict counting stub at globalThis.fetch; every
// request it did not expect fails the suite.
//
// Run: node tests/mcp-wiring.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function section(label) { console.log('=== ' + label); }

const harnessApi = await import('../src/product/harness-api.js');
const runtimeApi = await import('../src/product/runtime-api.js');
const persistenceMod = await import('../src/persistence.js');
const credMod = await import('../src/credentials.js');
const connMod = await import('../src/mcp-connections.js');
const portMod = await import('../src/product/mcp-port.js');
const toolAdapter = await import('../src/product/tool-adapter.js');
const tools = await import('../src/tools.js');
const { LocusMutationPolicy } = await import('../src/mutation-policy.js');

const TEST_TOKEN = 'mcp-wiring-token-4f8a';
const MCP_URL = 'https://mcp.wiring.test/mcp';
const MCP_CAP = {
  id: 'mcp-cap',
  version: '1.0.0',
  displayName: 'MCP Cap',
  description: 'TEST ONLY MCP wiring fixture.',
  plugins: [],
  skills: [],
  mcps: ['acmedocs'],
  credentials: [{
    name: 'MW_KEY',
    label: 'Acme key',
    description: 'TEST ONLY.',
    origin: 'https://mcp.wiring.test',
    pathPrefix: '/',
    header: 'Authorization',
    scheme: 'Bearer',
  }],
};
// A legacy entry (no endpoint): never connectable (§3.5).
const LEGACY_CAP = {
  id: 'legacy-cap',
  version: '1.0.0',
  displayName: 'Legacy Cap',
  description: 'TEST ONLY legacy fixture.',
  plugins: [],
  skills: [],
  mcps: ['oldrelay'],
  credentials: [],
};
// The MCP descriptors live in the manager's mcps CATALOG; the capability
// references them by id (the same split as plugins/skills).
const MCP_DESCRIPTORS = [
  {
    id: 'acmedocs',
    displayName: 'Acme Documents',
    description: 'TEST ONLY MCP server.',
    url: MCP_URL,
    auth: 'bearer',
    credential: 'MW_KEY',
  },
  { id: 'oldrelay', displayName: 'Old Relay', description: 'TEST ONLY.' },
];

async function wiredChain() {
  const persistence = new persistenceMod.PersistenceService();
  const manager = new harnessApi.CapabilityManager({
    catalogs: {
      capabilities: [MCP_CAP, LEGACY_CAP],
      plugins: [],
      skills: [],
      mcps: MCP_DESCRIPTORS,
    },
    sources: new harnessApi.SkillSourceStore(),
    instances: null,
  });
  const credentials = credMod.createCredentialService({ persistence, manager });
  const stateWrites = [];
  const mcpConnections = connMod.createMcpConnectionService({
    persistence,
    manager,
    credentials,
    setState: (id, state, reasonToken) => {
      stateWrites.push({ id, state, reason: reasonToken });
      manager.setMcpState(id, state, reasonToken);
    },
  });
  const approvals = harnessApi.createApprovalController({});
  const host = await runtimeApi.createRuntime({
    workerAssets: {
      pyWorkerSource: runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE,
      grepWorkerSource: runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE,
    },
  });
  const session = host.createSession();
  const vfs = runtimeApi.createWorkspace();
  let taskPort = null; // the per-task port, built exactly like prepareTask does
  const toolPort = toolAdapter.createLocusToolPort({
    definitions: () => tools.AGENT_TOOL_DEFINITIONS.slice(),
    execute: (name, input, workspace, o) => tools.executeTool(name, input, workspace, o),
    resolveRuntimeSession: async () => session,
    mutationPolicy: () => LocusMutationPolicy.create(),
    authorization: () => ({
      request: async () => ({ outcome: 'allow', scope: 'session' }),
    }),
    credentials: () => {
      const credPort = {
        bindings: async () => {
          const out = [];
          for (const cap of manager.listCapabilities()) {
            if (!cap.enabled || cap.state !== 'ready') continue;
            for (const c of (cap.credentials || [])) {
              out.push({ name: c.name, origin: c.origin, pathPrefix: c.pathPrefix,
                header: c.header, scheme: c.scheme, state: c.state });
            }
          }
          return out;
        },
        value: async (name) => {
          const v = credentials.valueOf(name);
          if (typeof v !== 'string' || !v.length) throw new Error('credential ' + name + ' is not available');
          return v;
        },
      };
      return credPort;
    },
    // C3 phase-2: the CURRENT task's port — the same closure shape the
    // store wires (`mcp: mcpTaskPortActive ? (() => activeTaskMcpPort) : null`).
    mcp: () => taskPort,
  });

  function buildTaskPort() {
    const env = manager.buildTaskEnvironment(); // the frozen task snapshot
    taskPort = portMod.createProductMcpPort({
      snapshot: env.mcps,
      capabilityName: (id) => env.capabilities.find((c) => c.mcpIds.includes(id))?.displayName,
      liveState: (serverId) => {
        const cap = manager.listCapabilities()
          .find((c) => Array.isArray(c.mcps) && c.mcps.some((m) => m && m.id === serverId));
        const m = cap ? (cap.mcps || []).find((x) => x && x.id === serverId) : null;
        return m ? m.state : null;
      },
      record: (serverId) => mcpConnections.record(serverId),
      reason: (serverId) => mcpConnections.reason(serverId),
      setReason: (serverId, token) => mcpConnections.setReason(serverId, token),
      setState: (serverId, state, reasonToken) => {
        stateWrites.push({ id: serverId, state, reason: reasonToken });
        manager.setMcpState(serverId, state, reasonToken);
      },
      approvals,
      conversationId: 'conv-wiring',
      taskGeneration: 1,
    });
    return taskPort;
  }
  async function endTask() {
    const port = taskPort;
    taskPort = null;
    const p = runtimeApi.disposeMcpTaskClient(port); // the runtime's public entry
    await (p || Promise.resolve());
  }

  return { persistence, manager, credentials, mcpConnections, approvals, session, vfs,
    toolPort, buildTaskPort, endTask, stateWrites };
}

// ---------- the strict counting MCP server stub ----------
const calls = []; // { method, headers, body }
const deletes = [];
let sseController = null; // the in-flight tools/call stream
let initializedSeen = null; // headers of the notifications/initialized POST
const realFetch = globalThis.fetch;
function jsonRpc(result, headers, id) {
  const wire = { jsonrpc: '2.0' };
  if (id !== undefined) wire.id = id;
  wire.result = result;
  return new Response(JSON.stringify(wire),
    { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}
const enc = new TextEncoder();
function installMcpStub() {
  globalThis.fetch = async (url, opts) => {
    const target = String(url);
    if (target !== MCP_URL) throw new Error('unexpected fetch target: ' + target);
    // openDirectIncremental encodes string bodies to bytes (network.js
    // toRequestBody) — decode before parsing.
    const rawBody = opts && opts.body;
    const body = rawBody == null ? null
      : typeof rawBody === 'string' ? JSON.parse(rawBody)
        : JSON.parse(new TextDecoder('utf-8').decode(
          rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody)));
    const call = { method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body };
    calls.push(call);
    if (call.method === 'DELETE') {
      deletes.push(call);
      return new Response(null, { status: 204 });
    }
    const m = body && body.method;
    if (m === 'initialize') {
      return jsonRpc({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'acme-mcp', version: '1.4.0' },
      }, { 'mcp-session-id': 'sess-wiring-1' }, body.id);
    }
    if (m === 'notifications/initialized') {
      initializedSeen = { headers: call.headers };
      return new Response(null, { status: 202 });
    }
    if (m === 'tools/list') {
      return jsonRpc({ tools: [{
        name: 'search',
        description: 'Search the Acme docs.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }], nextCursor: null }, null, body.id);
    }
    if (m === 'tools/call') {
      // SSE with a mid-stream form: hold the stream open until the reply
      // POST for the server request id arrives, then finish the call.
      const requestId = body.id;
      const stream = new ReadableStream({
        start(controller) {
          sseController = controller;
          const form = { jsonrpc: '2.0', id: 9001, method: 'elicitation/create',
            params: { message: 'Which workspace?',
              requestedSchema: { type: 'object',
                properties: { workspace: { type: 'string', enum: ['alpha', 'beta'] } },
                required: ['workspace'] } } };
          controller.enqueue(enc.encode('data: ' + JSON.stringify(
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) + '\n\n'));
          controller.enqueue(enc.encode('data: ' + JSON.stringify(form) + '\n\n'));
        },
      });
      sseController.requestId = requestId;
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (body && body.result !== undefined && body.id !== undefined) {
      // the form reply — echo the answer in the final tools/call result,
      // including the RAW TOKEN so MW4 can prove the redaction.
      if (sseController && sseController.requestId === undefined) { /* not ours */ }
      const final = { jsonrpc: '2.0', id: sseController ? sseController.requestId : body.id,
        result: { content: [{ type: 'text', text: 'answered:' + JSON.stringify(body.result.content)
          + ' token:' + TEST_TOKEN }], isError: false } };
      if (sseController) {
        sseController.enqueue(enc.encode('data: ' + JSON.stringify(final) + '\n\n'));
        sseController.close();
        sseController = null;
      }
      return new Response(null, { status: 202 });
    }
    throw new Error('unexpected MCP request: ' + JSON.stringify(body));
  };
}

(async () => {
  installMcpStub();
  try {
    // ---------- MW1: connect (no network), snapshot + live state ----------
    section('MW1 connect decision, task snapshot, zero network');
    const chain = await wiredChain();
    await chain.manager.enable('mcp-cap');
    await chain.manager.enable('legacy-cap');
    await chain.credentials.connect('MW_KEY', TEST_TOKEN, { remember: true });
    const before = calls.length;
    await chain.mcpConnections.connect('acmedocs', { token: '', remember: true });
    check('MW1 the connect decision wrote the record + flipped the state with NO network',
      calls.length === before && (await chain.mcpConnections.record('acmedocs')) !== null
      && (await chain.mcpConnections.record('acmedocs')).url === MCP_URL,
      'calls=' + calls.length);

    chain.buildTaskPort();
    const res1 = await chain.toolPort.execute({
      name: 'bash', input: 'mcp servers', context: { filesystem: chain.vfs } });
    check('MW1 mcp servers lists the connected server (and the legacy one unavailable)',
      res1.success === true
      && /acmedocs\s+connected/.test(res1.output)
      && /oldrelay\s+unavailable/.test(res1.output), res1.output);
    check('MW1 still zero network after mcp servers', calls.length === before,
      'calls=' + calls.length);

    // ---------- MW2: the handshake on the real wire ----------
    section('MW2 handshake wire format');
    const res2 = await chain.toolPort.execute({
      name: 'bash', input: 'mcp tools acmedocs', context: { filesystem: chain.vfs } });
    check('MW2 mcp tools lists the server tool', res2.success === true && /search/.test(res2.output),
      res2.output.slice(0, 200));
    const init = calls.find((c) => c.body && c.body.method === 'initialize');
    check('MW2 initialize carries accept/content-type/bearer, NO version/session headers',
      init && init.headers.accept === 'application/json, text/event-stream'
      && init.headers.authorization === 'Bearer ' + TEST_TOKEN
      && !init.headers['mcp-protocol-version'] && !init.headers['mcp-session-id'],
      JSON.stringify(init && init.headers));
    check('MW2 the initialized notification carries the negotiated version AND the issued session id',
      initializedSeen && initializedSeen.headers['mcp-protocol-version'] === '2025-06-18'
      && initializedSeen.headers['mcp-session-id'] === 'sess-wiring-1',
      JSON.stringify(initializedSeen && initializedSeen.headers));
    check('MW2 the bearer reached the strict server on the MCP request',
      init && init.headers.authorization === 'Bearer ' + TEST_TOKEN);

    // ---------- MW3: mid-stream form elicitation ----------
    section('MW3 form elicitation through the approval controller');
    const approvals = chain.approvals;
    const callPromise = chain.toolPort.execute({
      name: 'bash', input: `mcp call acmedocs search '{"query":"x"}'`,
      context: { filesystem: chain.vfs } });
    // The form arrives on the stream; the ApprovalController holds it.
    for (let i = 0; i < 100 && !approvals.pending; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    check('MW3 the form is pending as the harness elicitation kind',
      approvals.pending && approvals.pending.kind === 'elicitation'
      && approvals.pending.elicitation.message === 'Which workspace?'
      && approvals.pending.elicitation.requestedSchema.type === 'object',
      JSON.stringify(approvals.pending && approvals.pending.kind));
    check('MW3 the card identity names the capability, server and endpoint',
      approvals.pending.resource && approvals.pending.resource.label === 'MCP Cap · Acme Documents · ' + MCP_URL,
      JSON.stringify(approvals.pending && approvals.pending.resource));
    check('MW3 the tools/call is in flight while the form is open (stream held)',
      calls.filter((c) => c.body && c.body.method === 'tools/call').length === 1);
    approvals.resolve(approvals.pending.id, { outcome: 'accept', content: { workspace: 'alpha' } });
    const res3 = await callPromise;
    check('MW3 the SAME tools/call finished after the form was answered',
      res3.success === true && res3.output.includes('answered:')
      && res3.output.includes('alpha'), res3.output.slice(0, 300));
    const reply = calls.find((c) => c.body && c.body.id === 9001 && c.body.result);
    check('MW3 the reply posted the SERVER request id with the answer',
      reply && reply.body.result.action === 'accept'
      && JSON.stringify(reply.body.result.content) === '{"workspace":"alpha"}',
      JSON.stringify(reply && reply.body));
    check('MW3 exactly one tools/call left the client',
      calls.filter((c) => c.body && c.body.method === 'tools/call').length === 1);

    // ---------- MW4: the token never reaches model-visible output ----------
    section('MW4 token shielding');
    check('MW4 the tool output never contains the token (the server echoed it; the client redacted)',
      !res3.output.includes(TEST_TOKEN), JSON.stringify(res3.output.slice(0, 200)));

    // ---------- MW5: task end → exactly one DELETE ----------
    section('MW5 task-end dispose');
    await chain.endTask();
    check('MW5 the task end sent exactly one DELETE (session id + version + bearer)',
      deletes.length === 1 && deletes[0].headers['mcp-session-id'] === 'sess-wiring-1'
      && deletes[0].headers['mcp-protocol-version'] === '2025-06-18'
      && deletes[0].headers.authorization === 'Bearer ' + TEST_TOKEN,
      JSON.stringify(deletes.map((d) => d.headers)));
    await chain.endTask(); // a second call with no port: safe no-op
    check('MW5 a repeated task end adds no DELETE', deletes.length === 1);

    // ---------- MW6: state discipline ----------
    section('MW6 state discipline');
    const bad = portMod.createProductMcpPort({
      snapshot: [{ id: 'x', displayName: 'X', url: MCP_URL, auth: 'bearer', credential: 'MW_KEY' }],
      liveState: () => 'connected',
      record: async () => null, // no record → never reported connected
      reason: () => null,
      setReason: () => {},
      setState: (id, state) => { chain.stateWrites.push({ id, state, via: 'port' }); },
      approvals: chain.approvals,
      conversationId: null,
      taskGeneration: null,
    });
    const listed = await bad.servers();
    check('MW6 a connected state without a matching record reads needs-connection (§5.6.3)',
      listed.length === 1 && listed[0].state === 'needs-connection', JSON.stringify(listed));
    bad.setState('x', 'unreachable'); // not a harness state
    bad.setState('x', 'unavailable');
    check('MW6 the port writes only the three harness states (a 4th is refused)',
      chain.stateWrites.filter((w) => w.state === 'unreachable').length === 0
      && chain.stateWrites.some((w) => w.state === 'unavailable'), JSON.stringify(chain.stateWrites));

    // ---------- MW7: legacy entries never connectable ----------
    section('MW7 legacy no-endpoint entries');
    const legacyPort = portMod.createProductMcpPort({
      snapshot: (chain.manager.buildTaskEnvironment()).mcps.filter((m) => m.id === 'oldrelay'),
      liveState: (id) => {
        const cap = chain.manager.listCapabilities()
          .find((c) => Array.isArray(c.mcps) && c.mcps.some((m) => m && m.id === id));
        const m = cap ? (cap.mcps || []).find((x) => x && x.id === id) : null;
        return m ? m.state : null;
      },
      record: async () => null,
      reason: () => null,
      setReason: () => {},
      setState: () => {},
      approvals: chain.approvals,
      conversationId: null,
      taskGeneration: null,
    });
    const legacyList = await legacyPort.servers();
    check('MW7 a legacy entry is unavailable (no-endpoint) and carries no endpoint',
      legacyList.length === 1 && legacyList[0].state === 'unavailable'
      && legacyList[0].url === null, JSON.stringify(legacyList));
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();

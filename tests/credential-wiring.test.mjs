// C3 credential WIRING e2e (node, REAL runtime, NO DOM):
// the full product chain a model command takes —
//
//   createLocusToolPort (src/product/tool-adapter.js, the production
//   adapter) → executeTool (src/tools.js: context.credentials) →
//   REAL RuntimeSession.execute (locus-runtime, ctx.credentials) →
//   shell curl → NetworkRuntime → the credential PORT
//   (src/product/credential-port.js) → the credential service
//   (src/credentials.js) → manager states.
//
//   CW1  connected: `curl -X POST …/v1/tools/search -H "Authorization:
//        Bearer $TEST_KEY" -d '{}'` reaches the (stubbed) relay envelope
//        with `authorization: Bearer <value>` and redirect:"manual"; the
//        command echo keeps the literal $TEST_KEY
//   CW2  approval summary names the credential, never the value
//   CW3  disabled capability → network_credential_unknown (enabled-only
//        bindings degrade)
//   CW4  not connected → network_credential_not_connected
//   CW5  literal key on a bound target is refused
//        (network_credential_literal_refused)
//
// The relay is stubbed at globalThis.fetch (the runtime POSTs the JSON
// envelope to the relative /fetch path); the upstream response is a 200.
//
// Run: node tests/credential-wiring.test.mjs

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
const portMod = await import('../src/product/credential-port.js');
const toolAdapter = await import('../src/product/tool-adapter.js');
const tools = await import('../src/tools.js');
const { LocusMutationPolicy } = await import('../src/mutation-policy.js');

const TEST_NAME = 'TEST_KEY';
const TEST_VALUE = 'sk-wiring-abcdef123456';
const CRED_CAP = {
  id: 'wired-cap',
  version: '1.0.0',
  displayName: 'Wired Cap',
  description: 'TEST ONLY wiring fixture.',
  plugins: [],
  skills: [],
  mcps: [],
  credentials: [{
    name: TEST_NAME,
    label: 'Wiring key',
    description: 'TEST ONLY.',
    origin: 'https://api.example.test',
    pathPrefix: '/v1/tools/',
    header: 'Authorization',
    scheme: 'Bearer',
  }],
};

const CURL_CMD = 'curl -X POST https://api.example.test/v1/tools/search '
  + '-H "Authorization: Bearer $' + TEST_NAME + '" '
  + "-d '{}'";

async function wiredChain() {
  const persistence = new persistenceMod.PersistenceService();
  const manager = new harnessApi.CapabilityManager({
    catalogs: { capabilities: [CRED_CAP], plugins: [], skills: [], mcps: [] },
    sources: new harnessApi.SkillSourceStore(),
    instances: null,
  });
  const service = credMod.createCredentialService({ persistence, manager });
  const port = portMod.createProductCredentialPort({ manager, service });
  const host = await runtimeApi.createRuntime({
    workerAssets: {
      pyWorkerSource: runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE,
      grepWorkerSource: runtimeApi.runtimeWorkerAssets.GREP_WORKER_SOURCE,
    },
  });
  const session = host.createSession();
  const vfs = runtimeApi.createWorkspace();
  const approvalRequests = [];
  const toolPort = toolAdapter.createLocusToolPort({
    definitions: () => tools.AGENT_TOOL_DEFINITIONS.slice(),
    execute: (name, input, workspace, o) => tools.executeTool(name, input, workspace, o),
    resolveRuntimeSession: async () => session,
    mutationPolicy: () => LocusMutationPolicy.create(),
    // Always allow: the approval CONTRACT is exercised in the approval
    // suites; here it just observes what the runtime asked.
    authorization: () => ({
      request: async (req) => {
        approvalRequests.push(req);
        return { outcome: 'allow', scope: 'session' };
      },
    }),
    credentials: () => port,
  });
  return { persistence, manager, service, port, session, vfs, toolPort, approvalRequests };
}

// Relay stub: the runtime's edge-relay backend POSTs the JSON envelope to
// the relative '/fetch' path. Capture envelopes, answer 200.
const realFetch = globalThis.fetch;
const envelopes = [];
function installRelayStub() {
  globalThis.fetch = async (url, opts) => {
    if (String(url) === '/fetch') {
      const envelope = JSON.parse(String(opts.body));
      envelopes.push(envelope);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch target: ' + String(url));
  };
}

(async () => {
  installRelayStub();
  try {
    // ---------- CW1 + CW2: the connected path ----------
    section('CW1/CW2 connected: envelope header + literal echo');
    const chain = await wiredChain();
    await chain.manager.enable('wired-cap');
    await chain.service.connect(TEST_NAME, TEST_VALUE, { remember: true });

    const res = await chain.toolPort.execute({
      name: 'bash',
      input: CURL_CMD,
      context: { filesystem: chain.vfs },
    });
    check('CW1 the command succeeds', res.success === true, res.output.slice(0, 300));
    // The shell never expands the variable — the ONLY place the value
    // appeared is the outgoing header (proven above); the response is
    // byte-scanned so the value cannot echo back either.
    check('CW1 the value never appears in the command result',
      !res.output.includes(TEST_VALUE), JSON.stringify(res.output.slice(0, 200)));
    check('CW1 exactly one relay envelope was sent', envelopes.length === 1,
      'envelopes=' + envelopes.length);
    const env1 = envelopes[0] || {};
    check('CW1 the envelope carries method/target', env1.method === 'POST'
      && env1.url === 'https://api.example.test/v1/tools/search', JSON.stringify(env1.url));
    check('CW1 the credential value substituted into the header',
      env1.headers && env1.headers.authorization === 'Bearer ' + TEST_VALUE,
      JSON.stringify(env1.headers));
    check('CW1 a credentialed envelope asks the relay redirect:"manual"',
      env1.redirect === 'manual', JSON.stringify(env1.redirect));
    check('CW2 the approval request names the credential, never the value',
      chain.approvalRequests.length === 1
      && chain.approvalRequests[0].policyKey === 'network-write:https://api.example.test'
      && String(chain.approvalRequests[0].action.detail || '').includes('Uses credential: ' + TEST_NAME)
      && JSON.stringify(chain.approvalRequests).includes(TEST_VALUE) === false,
      JSON.stringify(chain.approvalRequests[0]));

    // ---------- CW3: disabled capability → unknown ----------
    section('CW3 disabled capability → network_credential_unknown');
    await chain.manager.disable('wired-cap');
    envelopes.length = 0;
    const res3 = await chain.toolPort.execute({
      name: 'bash',
      input: CURL_CMD,
      context: { filesystem: chain.vfs },
    });
    check('CW3 disabled capability refuses as an unknown credential',
      res3.success === false && res3.output.includes('unknown credential: ' + TEST_NAME),
      JSON.stringify(res3.output.slice(0, 240)));
    check('CW3 nothing was sent', envelopes.length === 0, 'envelopes=' + envelopes.length);
    await chain.manager.enable('wired-cap');

    // ---------- CW4: not connected → network_credential_not_connected ----------
    section('CW4 not connected → network_credential_not_connected');
    await chain.service.disconnect(TEST_NAME);
    envelopes.length = 0;
    const res4 = await chain.toolPort.execute({
      name: 'bash',
      input: CURL_CMD,
      context: { filesystem: chain.vfs },
    });
    check('CW4 unconnected credential refuses with the connect hint',
      res4.success === false && res4.output.includes('is not connected')
      && res4.output.includes('Settings'),
      JSON.stringify(res4.output.slice(0, 240)));
    check('CW4 nothing was sent', envelopes.length === 0, 'envelopes=' + envelopes.length);

    // ---------- CW5: a literal key on the bound target is refused ----------
    section('CW5 literal key refused on the bound target');
    await chain.service.connect(TEST_NAME, TEST_VALUE, { remember: false });
    envelopes.length = 0;
    const literalCmd = 'curl -X POST https://api.example.test/v1/tools/search '
      + '-H "Authorization: Bearer ' + TEST_VALUE + '" '
      + "-d '{}'";
    const res5 = await chain.toolPort.execute({
      name: 'bash',
      input: literalCmd,
      context: { filesystem: chain.vfs },
    });
    check('CW5 a literal value on the bound header is refused with the variable hint',
      res5.success === false && res5.output.includes('refusing to send a literal value')
      && res5.output.includes('$' + TEST_NAME),
      JSON.stringify(res5.output.slice(0, 240)));
    check('CW5 the literal value never reached the network',
      envelopes.length === 0 && !res5.output.includes(TEST_VALUE),
      'envelopes=' + envelopes.length);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('---');
  console.log('credential-wiring.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { globalThis.fetch = realFetch; console.error(e); process.exit(1); });

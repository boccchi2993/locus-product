// C3 persistent approvals ("Always allow") battery (node, NO DOM):
// docs/C3-CREDENTIALS-MCP.md §6 over the REAL harness ApprovalController
// and the REAL PersistenceService in its memory mode.
//
//   AG1  persistence load/save: sorted + de-duplicated, round trip,
//        reset() clears
//   AG2  controller round trip: allow persistent → the port holds it → a
//        REBUILT controller + load auto-allows the same policyKey without
//        a prompt (viaGrant)
//   AG3  revoke: a revoked grant asks again
//   AG4  fail closed: a broken port loads to an EMPTY grant set
//   AG5  store level: listAlwaysAllowed labels (`Write requests to
//        <origin>`), the grant survives a store re-import + boot, revoke
//        through revokeAlwaysAllowed, resetAllData empties the list and
//        clears the credential bindings
//
// Run: node tests/approval-grants.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function section(label) { console.log('=== ' + label); }

const harnessApi = await import('../src/product/harness-api.js');
const persistenceMod = await import('../src/persistence.js');

const POLICY = 'network-write:https://api.example.test';

// The port shape store.js builds over persistence (load/add/remove).
function grantsPort(persistence) {
  return {
    load: () => persistence.loadApprovalGrants(),
    add: async (policyKey) => {
      const keys = await persistence.loadApprovalGrants();
      if (!keys.includes(policyKey)) keys.push(policyKey);
      await persistence.saveApprovalGrants(keys);
    },
    remove: async (policyKey) => {
      const keys = await persistence.loadApprovalGrants();
      await persistence.saveApprovalGrants(keys.filter((k) => k !== policyKey));
    },
  };
}

function controller(persistence, overrides) {
  return harnessApi.createApprovalController({
    persistentGrants: grantsPort(persistence),
    ...(overrides || {}),
  });
}

async function requestPermission(c, policyKey) {
  return c.request({
    kind: 'permission',
    action: { type: 'network-request', summary: 'POST ' + policyKey },
    resource: { type: 'network-origin', key: policyKey, label: policyKey },
    policyKey,
  });
}

// ---------- AG1. persistence round trip ----------
{
  section('AG1 persistence load/save');
  const p = new persistenceMod.PersistenceService();
  await p.saveApprovalGrants(['b-key', 'a-key', 'b-key', '']);
  check('AG1 save sorts, de-duplicates and drops empties',
    JSON.stringify(await p.loadApprovalGrants()) === JSON.stringify(['a-key', 'b-key']),
    JSON.stringify(await p.loadApprovalGrants()));
  check('AG1 load on an empty store is an empty array',
    JSON.stringify(await new persistenceMod.PersistenceService().loadApprovalGrants()) === '[]');
  await p.saveApprovalGrants([POLICY]);
  await p.reset();
  check('AG1 reset() clears the grants',
    JSON.stringify(await p.loadApprovalGrants()) === '[]');
}

// ---------- AG2. controller round trip across a "restart" ----------
{
  section('AG2 persistent grant survives a controller rebuild');
  const p = new persistenceMod.PersistenceService();
  const c1 = controller(p);
  const settle1 = requestPermission(c1, POLICY); // NOT awaited: it settles on the decision
  await new Promise((r) => setTimeout(r, 0));
  check('AG2 first request pends', c1.pending !== null);
  const resolved = await c1.resolve(c1.pending.id, { outcome: 'allow', scope: 'persistent' });
  const decision = await settle1;
  // The controller's memory set is the decision authority; the port
  // mirror is async — let its write settle before reading it back.
  await new Promise((r) => setTimeout(r, 0));
  check('AG2 allow persistent settles the request', resolved === true
    && decision.outcome === 'allow' && decision.scope === 'persistent',
    JSON.stringify(decision));
  check('AG2 the port holds the grant',
    JSON.stringify(await p.loadApprovalGrants()) === JSON.stringify([POLICY]),
    JSON.stringify(await p.loadApprovalGrants()));

  // "Restart": a fresh controller over the same storage, boot-loads.
  const c2 = controller(p);
  const loaded = await c2.loadPersistentGrants();
  check('AG2 load returns the stored policyKey', JSON.stringify(loaded) === JSON.stringify([POLICY]),
    JSON.stringify(loaded));
  let prompted = false;
  const c2probe = harnessApi.createApprovalController({
    persistentGrants: grantsPort(p),
    onChange: () => { prompted = true; },
  });
  await c2probe.loadPersistentGrants();
  const decision2 = await requestPermission(c2probe, POLICY);
  check('AG2 the same policyKey auto-allows without a prompt (viaGrant)',
    prompted === false && decision2.outcome === 'allow'
    && decision2.scope === 'persistent' && decision2.viaGrant === true,
    JSON.stringify(decision2));
}

// ---------- AG3. revoke asks again ----------
{
  section('AG3 revoke: the next request prompts');
  const p = new persistenceMod.PersistenceService();
  const c1 = controller(p);
  await c1.loadPersistentGrants();
  const settle = requestPermission(c1, POLICY);
  await c1.resolve(c1.pending.id, { outcome: 'allow', scope: 'persistent' });
  await settle;
  await c1.revokePersistentGrant(POLICY);
  check('AG3 the port no longer holds it',
    JSON.stringify(await p.loadApprovalGrants()) === '[]');
  const c2 = controller(p);
  await c2.loadPersistentGrants();
  const settle2 = requestPermission(c2, POLICY);
  await new Promise((r) => setTimeout(r, 0));
  check('AG3 a revoked grant pends again', c2.pending !== null);
  await c2.resolve(c2.pending.id, { outcome: 'deny', scope: 'once' });
  await settle2;
}

// ---------- AG4. fail closed on a broken port ----------
{
  section('AG4 a failing load leaves an empty grant set');
  const p = new persistenceMod.PersistenceService();
  await p.saveApprovalGrants([POLICY]);
  const broken = harnessApi.createApprovalController({
    persistentGrants: {
      load: () => { throw new Error('storage exploded'); },
      add: async () => {},
      remove: async () => {},
    },
  });
  const loaded = await broken.loadPersistentGrants();
  check('AG4 the failed load reports an EMPTY set', Array.isArray(loaded) && loaded.length === 0,
    JSON.stringify(loaded));
  const settle = requestPermission(broken, POLICY);
  await new Promise((r) => setTimeout(r, 0));
  check('AG4 the request is NOT auto-allowed (prompts)', broken.pending !== null);
  await broken.resolve(broken.pending.id, { outcome: 'deny', scope: 'once' });
  await settle;
}

// ---------- AG5. store level ----------
{
  section('AG5 store: listAlwaysAllowed / revokeAlwaysAllowed / resetAllData');
  function fakeSessionStorage(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      removeItem: (k) => { map.delete(k); },
    };
  }
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { location: { protocol: 'https:' } };
  }
  const sharedPersistence = persistenceMod.PersistenceServiceInstance;
  globalThis.sessionStorage = fakeSessionStorage(null);
  await sharedPersistence.reset();
  let scenario = 0;

  {
    const m = await import('../src/ui/store.js?ag=' + (++scenario));
    await m.whenBooted;
    check('AG5 a fresh page lists no grants', JSON.stringify(m.listAlwaysAllowed()) === '[]');
    // Grant "always" through the REAL approval path.
    const settle = m.approvals.request({
      kind: 'permission',
      action: { type: 'network-request', summary: 'POST ' + POLICY },
      resource: { type: 'network-origin', key: 'https://api.example.test', label: 'api.example.test' },
      policyKey: POLICY,
    }, {});
    m.resolveApproval(m.store.pendingApproval.id, { outcome: 'allow', scope: 'persistent' });
    const decision = await settle;
    check('AG5 the store grant settles persistent', decision.outcome === 'allow'
      && decision.scope === 'persistent', JSON.stringify(decision));
    const list = m.listAlwaysAllowed();
    check('AG5 listAlwaysAllowed renders the friendly label',
      list.length === 1 && list[0].policyKey === POLICY
      && list[0].label === 'Write requests to https://api.example.test',
      JSON.stringify(list));
  }
  {
    // "Restart": the grant survives the reload through boot loading.
    const m = await import('../src/ui/store.js?ag=' + (++scenario));
    await m.whenBooted;
    const list = m.listAlwaysAllowed();
    check('AG5 the grant survives a reload and boots loaded',
      list.length === 1 && list[0].policyKey === POLICY, JSON.stringify(list));
    await m.revokeAlwaysAllowed(POLICY);
    check('AG5 revokeAlwaysAllowed empties the list',
      JSON.stringify(m.listAlwaysAllowed()) === '[]');
    const settle = m.approvals.request({
      kind: 'permission',
      action: { type: 'network-request', summary: 'POST ' + POLICY },
      resource: { type: 'network-origin', key: 'https://api.example.test', label: 'x' },
      policyKey: POLICY,
    }, {});
    await new Promise((r) => setTimeout(r, 0));
    check('AG5 a revoked grant prompts again in the store',
      m.store.pendingApproval !== null);
    m.resolveApproval(m.store.pendingApproval.id, { outcome: 'deny', scope: 'once' });
    await settle;
  }
  {
    // resetAllData: grant again, then reset — list empty, credential
    // bindings cleared alongside.
    const m = await import('../src/ui/store.js?ag=' + (++scenario));
    await m.whenBooted;
    const settle = m.approvals.request({
      kind: 'permission',
      action: { type: 'network-request', summary: 'POST ' + POLICY },
      resource: { type: 'network-origin', key: 'https://api.example.test', label: 'x' },
      policyKey: POLICY,
    }, {});
    m.resolveApproval(m.store.pendingApproval.id, { outcome: 'allow', scope: 'persistent' });
    await settle;
    check('AG5 setup: grant present before the reset', m.listAlwaysAllowed().length === 1);
    await m.resetAllData();
    check('AG5 resetAllData empties the always-allowed list',
      JSON.stringify(m.listAlwaysAllowed()) === '[]');
    check('AG5 resetAllData cleared the durable grants too',
      JSON.stringify(await sharedPersistence.loadApprovalGrants()) === '[]');
  }
}

console.log('---');
console.log('approval-grants.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

// MCP connection service tests (C3 phase-2 §5, node, NO DOM):
// connection records (meta key `mcpConnections`), connect / disconnect,
// boot restore (§5.3), version replacement reconciliation (§5.7
// afterReplace), integrity relock (§5.4 afterRelock), uninstall and
// reset cleanup, the in-memory failure-reason map (§5.5) and the legacy
// (no-endpoint) unavailable rule (§3.5) — over the REAL harness
// CapabilityManager, the REAL credential service and the REAL
// PersistenceService in its memory mode.
//
// State-write discipline: the rig injects a recording wrapper that
// FORWARDS to manager.setMcpState, so every write the service makes is
// visible and no second harness write surface is used.
//
// Run: node tests/mcp-connections.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 300) : '')); }
}

const harnessApi = await import('../src/product/harness-api.js');
const runtimeApi = await import('../src/product/runtime-api.js');
const persistenceMod = await import('../src/persistence.js');
const credMod = await import('../src/credentials.js');
const mcpMod = await import('../src/mcp-connections.js');
const { createCredentialService } = credMod;
const { createMcpConnectionService } = mcpMod;

const CRED = {
  name: 'ACME_API_TOKEN', label: 'Acme token', description: 'TEST ONLY.',
  origin: 'https://mcp.acme.example', pathPrefix: '/',
  header: 'Authorization', scheme: 'Bearer',
};
const TOKEN = 'sk-acme-test-9f8e7d6c';

function catalogs(opts) {
  const o = opts || {};
  return {
    capabilities: [{
      id: 'mcp-cap', version: '1', displayName: 'MCP Cap', description: 'TEST ONLY.',
      plugins: [], skills: [],
      mcps: o.mcps || ['acme-docs', 'legacy-service'],
      credentials: o.noCredentials ? [] : [Object.assign({}, CRED, o.credPatch || {})],
    }],
    plugins: [], skills: [],
    mcps: o.mcpDescriptors || [
      { id: 'acme-docs', displayName: 'Acme Documents', description: 'TEST ONLY.',
        url: 'https://mcp.acme.example/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN' },
      { id: 'legacy-service', displayName: 'Legacy Service', description: 'no endpoint' },
    ],
  };
}

async function rig(opts) {
  const o = opts || {};
  const persistence = o.persistence || new persistenceMod.PersistenceService();
  const manager = new harnessApi.CapabilityManager({
    catalogs: catalogs(o),
    sources: new harnessApi.SkillSourceStore(),
    instances: null,
  });
  const credentials = createCredentialService({ persistence, manager });
  const stateWrites = [];
  const mcp = createMcpConnectionService({
    persistence, manager, credentials,
    setState: (id, state) => { stateWrites.push([id, state]); manager.setMcpState(id, state); },
  });
  await manager.enable('mcp-cap');
  return { persistence, manager, credentials, mcp, stateWrites };
}

const stateOf = (manager, id) => {
  const cap = manager.listCapabilities().find((c) => c.id === 'mcp-cap');
  const m = cap && cap.mcps.find((x) => x.id === id);
  return m ? m.state : null;
};

async function recordsOf(persistence) {
  const row = await persistence.get('meta', 'mcpConnections');
  return row && Array.isArray(row.connections) ? row.connections : [];
}

(async () => {
  // ---------- R1. defaults + legacy restore (§5.3) ----------
  {
    const r = await rig();
    check('R1 fresh servers default to needs-connection',
      stateOf(r.manager, 'acme-docs') === 'needs-connection'
      && stateOf(r.manager, 'legacy-service') === 'needs-connection');
    await r.mcp.restore();
    check('R1b restore: legacy (no-endpoint) server is unavailable with the reason',
      stateOf(r.manager, 'legacy-service') === 'unavailable'
      && r.mcp.reason('legacy-service') === 'no-endpoint');
    check('R1c restore: connectable server without a record stays needs-connection',
      stateOf(r.manager, 'acme-docs') === 'needs-connection'
      && (await r.mcp.record('acme-docs')) === null);
    const rows = await recordsOf(r.persistence);
    check('R1d restore leaves no records behind', rows.length === 0, rows);
  }

  // ---------- R2. connect guards ----------
  {
    const r = await rig();
    await r.mcp.restore();
    const legacyThrow = await (r.mcp.connect('legacy-service', { token: TOKEN }).then(() => null, (e) => e));
    check('R2 connecting a legacy server is refused', !!legacyThrow
      && String(legacyThrow.message).includes('no endpoint'), legacyThrow && legacyThrow.message);
    const unknownThrow = await (r.mcp.connect('ghost', { token: TOKEN }).then(() => null, (e) => e));
    check('R2b connecting an unknown server is refused', !!unknownThrow
      && String(unknownThrow.message).includes('unknown server'));
    const noTokenThrow = await (r.mcp.connect('acme-docs', {}).then(() => null, (e) => e));
    check('R2c connect without a token and without a connected credential is refused',
      !!noTokenThrow && String(noTokenThrow.message).includes('ACME_API_TOKEN'),
      noTokenThrow && noTokenThrow.message);
    check('R2d the refusals wrote nothing',
      (await recordsOf(r.persistence)).length === 0
      && stateOf(r.manager, 'acme-docs') === 'needs-connection');
  }

  // ---------- R3. connect (§5.2): record + credential + state, no network ----------
  {
    const r = await rig();
    const rec = await r.mcp.connect('acme-docs', { token: TOKEN });
    check('R3 connect returns the record', !!rec
      && rec.serverId === 'acme-docs' && rec.capabilityId === 'mcp-cap'
      && rec.url === 'https://mcp.acme.example/mcp'
      && rec.auth === 'bearer' && rec.credential === 'ACME_API_TOKEN'
      && typeof rec.confirmedAt === 'number', rec);
    check('R3b the state flips to connected', stateOf(r.manager, 'acme-docs') === 'connected');
    check('R3c the credential holds the value',
      r.credentials.summary('ACME_API_TOKEN').state === 'connected'
      && r.credentials.summary('ACME_API_TOKEN').hasValue === true);
    const rows = await recordsOf(r.persistence);
    check('R3d the durable record carries metadata only (never the token)',
      rows.length === 1 && !('token' in rows[0]) && JSON.stringify(rows[0]).indexOf(TOKEN) === -1,
      Object.keys(rows[0] || {}));
    check('R3e a state write went through the single wrapper',
      r.stateWrites.some(([id, s]) => id === 'acme-docs' && s === 'connected'));
  }

  // ---------- R4. record() view + restore keeps a matched connection ----------
  {
    const r = await rig();
    await r.mcp.connect('acme-docs', { token: TOKEN });
    const rec = await r.mcp.record('acme-docs');
    check('R4 record() returns the §5.1 shape',
      !!rec && JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(
        ['auth', 'capabilityId', 'confirmedAt', 'credential', 'serverId', 'url']), rec);
    await r.mcp.restore();
    check('R4b restore keeps a matched, credentialed connection connected',
      stateOf(r.manager, 'acme-docs') === 'connected');
  }

  // ---------- R5. credential loss → needs-connection, record kept (§5.4) ----------
  {
    const r = await rig();
    await r.mcp.connect('acme-docs', { token: TOKEN });
    await r.credentials.disconnect('ACME_API_TOKEN');
    check('R5 disconnecting the credential keeps the server record', (await r.mcp.record('acme-docs')) !== null);
    await r.mcp.restore();
    check('R5b restore sends the server back to needs-connection',
      stateOf(r.manager, 'acme-docs') === 'needs-connection');
  }

  // ---------- R6. disconnect (§5.7): record deleted, token kept ----------
  {
    const r = await rig();
    await r.mcp.connect('acme-docs', { token: TOKEN });
    await r.mcp.disconnect('acme-docs');
    check('R6 disconnect removes the record and flips the state',
      (await r.mcp.record('acme-docs')) === null
      && stateOf(r.manager, 'acme-docs') === 'needs-connection');
    check('R6b the credential value is untouched',
      r.credentials.summary('ACME_API_TOKEN').hasValue === true);
    await r.mcp.disconnect('acme-docs'); // idempotent
    check('R6c disconnect is idempotent', stateOf(r.manager, 'acme-docs') === 'needs-connection');
  }

  // ---------- R7. afterReplace (§5.7) — four combinations ----------
  {
    // (a) unchanged declaration + connected credential → stays connected.
    const a = await rig();
    await a.mcp.connect('acme-docs', { token: TOKEN });
    await a.mcp.afterReplace('mcp-cap', [{ id: 'acme-docs', url: 'https://mcp.acme.example/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN' }]);
    check('R7a afterReplace keeps a matching record connected',
      stateOf(a.manager, 'acme-docs') === 'connected' && (await a.mcp.record('acme-docs')) !== null);

    // (b) changed url → needs-connection; the OLD record is kept.
    const b = await rig();
    await b.mcp.connect('acme-docs', { token: TOKEN });
    b.manager.replaceCatalogs(catalogs({ mcpDescriptors: [
      { id: 'acme-docs', displayName: 'Acme Documents', description: 'v2 endpoint',
        url: 'https://mcp.acme.example/v2/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN' },
      { id: 'legacy-service', displayName: 'Legacy Service', description: 'no endpoint' },
    ] }));
    await b.credentials.restore();
    await b.mcp.afterReplace('mcp-cap', [{ id: 'acme-docs', url: 'https://mcp.acme.example/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN' }]);
    check('R7b afterReplace sends a mismatched server to needs-connection',
      stateOf(b.manager, 'acme-docs') === 'needs-connection');
    const kept = await b.mcp.record('acme-docs');
    check('R7c the old record is kept for "the last connection" display',
      !!kept && kept.url === 'https://mcp.acme.example/mcp', kept);

    // (c) dropped server → record deleted.
    const c = await rig();
    await c.mcp.connect('acme-docs', { token: TOKEN });
    c.manager.replaceCatalogs(catalogs({ mcps: ['legacy-service'] }));
    await c.mcp.afterReplace('mcp-cap', [{ id: 'acme-docs', url: 'https://mcp.acme.example/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN' }]);
    check('R7d afterReplace deletes the record of a dropped server',
      (await c.mcp.record('acme-docs')) === null
      && (await recordsOf(c.persistence)).length === 0);

    // (d) new version's legacy entry → unavailable (no-endpoint).
    const d = await rig();
    await d.mcp.connect('acme-docs', { token: TOKEN });
    d.manager.replaceCatalogs(catalogs({ mcpDescriptors: [
      { id: 'acme-docs', displayName: 'Acme Documents', description: 'endpoint dropped' },
      { id: 'legacy-service', displayName: 'Legacy Service', description: 'no endpoint' },
    ] }));
    await d.mcp.afterReplace('mcp-cap', [{ id: 'acme-docs', url: 'https://mcp.acme.example/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN' }]);
    check('R7e afterReplace marks an endpoint-dropping replacement unavailable',
      stateOf(d.manager, 'acme-docs') === 'unavailable'
      && d.mcp.reason('acme-docs') === 'no-endpoint');
  }

  // ---------- R8. afterRelock (§5.4): states flip, records kept ----------
  {
    const r = await rig();
    await r.mcp.connect('acme-docs', { token: TOKEN });
    await r.mcp.afterRelock('mcp-cap');
    check('R8 afterRelock sends the server to needs-connection and keeps the record',
      stateOf(r.manager, 'acme-docs') === 'needs-connection'
      && (await r.mcp.record('acme-docs')) !== null);
  }

  // ---------- R9. removeForCapability + clearAll ----------
  {
    const r = await rig();
    await r.mcp.connect('acme-docs', { token: TOKEN });
    await r.mcp.removeForCapability('mcp-cap');
    check('R9 uninstall cleanup deletes the record and reconnects nothing',
      (await r.mcp.record('acme-docs')) === null
      && stateOf(r.manager, 'acme-docs') === 'needs-connection');
    await r.mcp.connect('acme-docs', { token: TOKEN });
    await r.mcp.clearAll();
    check('R9b clearAll wipes every record',
      (await recordsOf(r.persistence)).length === 0
      && (await r.mcp.record('acme-docs')) === null
      && stateOf(r.manager, 'acme-docs') === 'needs-connection'
      && stateOf(r.manager, 'legacy-service') === 'unavailable'
      && r.mcp.reason('legacy-service') === 'no-endpoint');
  }

  // ---------- R10. failure reasons are in-memory only (§5.5) ----------
  {
    const r = await rig();
    await r.mcp.connect('acme-docs', { token: TOKEN });
    r.mcp.setReason('acme-docs', 'http-503');
    check('R10 setReason is readable through reason()', r.mcp.reason('acme-docs') === 'http-503');
    // A second service instance over the SAME persistence sees the record
    // but NOT the reason: the map never persists.
    const fresh = createMcpConnectionService({ persistence: r.persistence, manager: r.manager, credentials: r.credentials });
    check('R10b a fresh service instance reads no reason (in-memory only)',
      fresh.reason('acme-docs') === null && (await fresh.record('acme-docs')) !== null);
    // Connect clears the reason; null clears it too.
    r.mcp.setReason('acme-docs', null);
    check('R10c a null token clears the reason', r.mcp.reason('acme-docs') === null);
    r.mcp.setReason('acme-docs', 'timeout');
    await r.mcp.connect('acme-docs', {});
    check('R10d a connect clears the recorded failure',
      r.mcp.reason('acme-docs') === null && stateOf(r.manager, 'acme-docs') === 'connected');
  }

  // ---------- R11. orphan cleanup on restore / afterReplace ----------
  {
    const r = await rig();
    await r.persistence.put('meta', { key: 'mcpConnections', connections: [
      { serverId: 'ghost-server', capabilityId: 'mcp-cap', url: 'https://ghost.example.test/mcp', auth: 'bearer', credential: 'ACME_API_TOKEN', confirmedAt: 1 },
    ] });
    await r.mcp.restore();
    check('R11 restore deletes records of undeclared servers',
      (await recordsOf(r.persistence)).length === 0);
  }

  // ---------- R12. the no-service degradation (no credentials service) ----------
  {
    const persistence = new persistenceMod.PersistenceService();
    const manager = new harnessApi.CapabilityManager({
      catalogs: catalogs(), sources: new harnessApi.SkillSourceStore(), instances: null,
    });
    const mcp = createMcpConnectionService({ persistence, manager });
    const guard = await (mcp.connect('acme-docs', { token: TOKEN }).then(() => null, (e) => e));
    check('R12 connect without a credential service fails loudly', !!guard
      && String(guard.message).includes('credential service'), guard && guard.message);
    await mcp.restore();
    check('R12b restore without a credential service still resolves states',
      stateOf(manager, 'legacy-service') === 'unavailable'
      && stateOf(manager, 'acme-docs') === 'needs-connection');
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' mcp-connection checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('SUITE ERROR', e);
  process.exit(1);
});

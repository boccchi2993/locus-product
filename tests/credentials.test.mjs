// C3 credential service unit battery (node, NO DOM):
// docs/C3-CREDENTIALS-MCP.md §3 over the REAL harness CapabilityManager
// and the REAL PersistenceService in its memory mode.
//
//   CR1  connect validation: empty / control chars / unknown name; the
//        value never appears in any error
//   CR2  connect: binding record (§3.2 shape), remembered row, state
//        connected, value inside the redaction set (remembered AND not)
//   CR3  connect remember:false removes a stale remembered row
//   CR4  reconfirm: only needs-reconfirm + in-memory value; record is
//        rewritten to the CURRENT declaration; state connected
//   CR5  disconnect: memory + remembered row + binding record + volatile
//        redaction gone; state needs-connection; idempotent
//   CR6  restore: the four per-credential cases + orphan record cleanup
//   CR7  afterReplace: unchanged keeps connected, changed →
//        needs-reconfirm (value kept), dropped credential → disconnected
//   CR8  removeForCapability: registered AND unregistered-but-bound
//   CR9  clearAll: memory, records, capcred rows, redaction, states
//   CR10 summary: state/hasValue/last4 (null under 8 chars)
//   CR11 the credential port: enabled-only bindings, exact shape,
//        value() throws for a missing value (never leaking it)
//   CR12 volatile secrets survive a secrets-store reload (_loadSecrets)
//   CR13 harness.credentialBindingChanged injection is honored
//
// Run: node tests/credentials.test.mjs

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function section(label) { console.log('=== ' + label); }
const rejectionOf = (p) => p.then(() => null, (e) => e);

const harnessApi = await import('../src/product/harness-api.js');
const persistenceMod = await import('../src/persistence.js');
const credMod = await import('../src/credentials.js');
const portMod = await import('../src/product/credential-port.js');
const { createCredentialService } = credMod;
const { createProductCredentialPort } = portMod;

const FIXED_NOW = () => 1792300000000;
const TEST_VALUE = 'sk-test-9f8e7d6c5b4a';
const TEST_NAME = 'TEST_KEY';

// One capability whose descriptor declares the credential(s) under test.
function credCapability(opts) {
  const o = opts || {};
  return {
    id: o.id || 'cred-cap',
    version: o.version || '1.0.0',
    displayName: 'Cred Cap',
    description: 'TEST ONLY capability fixture.',
    plugins: [],
    skills: [],
    mcps: [],
    credentials: (o.credentials || [{
      name: TEST_NAME,
      label: 'Test key',
      description: 'TEST ONLY routing metadata.',
      origin: 'https://api.example.test',
      pathPrefix: '/v1/tools/',
      header: 'Authorization',
      scheme: 'Bearer',
    }]),
  };
}

function newManager(capabilities) {
  return new harnessApi.CapabilityManager({
    catalogs: {
      capabilities: capabilities || [credCapability()],
      plugins: [],
      skills: [],
      mcps: [],
    },
    sources: new harnessApi.SkillSourceStore(),
    instances: null,
  });
}

function rig(opts) {
  const o = opts || {};
  const persistence = o.persistence || new persistenceMod.PersistenceService();
  const manager = o.manager || newManager(o.capabilities);
  const service = createCredentialService({
    persistence, manager,
    ...(o.harness ? { harness: o.harness } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return { persistence, manager, service };
}

async function bindingsOf(persistence) {
  const row = await persistence.get('meta', 'credentialBindings');
  return row && Array.isArray(row.bindings) ? row.bindings : [];
}

async function secretRowOf(persistence, name) {
  return persistence.get('secrets', 'capcred:' + encodeURIComponent(name));
}

// Redaction probe: the value must never survive a conversation write.
async function redactsValue(persistence) {
  await persistence.saveConversation({ id: 'probe-' + Date.now(), note: 'leak? ' + TEST_VALUE });
  const rows = await persistence.loadConversations();
  const probe = rows.find((r) => r.note && r.note.startsWith('leak?'));
  return !!probe && probe.note === 'leak? [REDACTED]';
}

(async () => {
  // ---------- CR1. connect validation ----------
  {
    section('CR1 connect validation');
    const { service } = rig();
    let err = await rejectionOf(service.connect(TEST_NAME, '   ', {}));
    check('CR1 whitespace-only value refused', !!err && /non-empty/.test(err.message), err && err.message);
    err = await rejectionOf(service.connect(TEST_NAME, 'abc\ndef', {}));
    check('CR1 control characters refused', !!err && /control/.test(err.message), err && err.message);
    err = await rejectionOf(service.connect('OTHER_KEY', TEST_VALUE, {}));
    check('CR1 unknown credential refused by name', !!err && /unknown credential: OTHER_KEY/.test(err.message), err && err.message);
    err = await rejectionOf(service.connect(TEST_NAME, 42, {}));
    check('CR1 non-string value refused', !!err && /non-empty/.test(err.message), err && err.message);
    // The value never appears in an error message.
    const bad = await rejectionOf(service.connect(TEST_NAME, 'x'.repeat(3) + '\u0007', {}));
    check('CR1 no error message carries the value',
      !!bad && !bad.message.includes(TEST_VALUE.slice(-6)) && !JSON.stringify(bad).includes(TEST_VALUE),
      bad && bad.message);
  }

  // ---------- CR2. connect happy path ----------
  {
    section('CR2 connect: record, secret, state, redaction');
    const { persistence, manager, service } = rig({ now: FIXED_NOW });
    const summary = await service.connect(TEST_NAME, '  ' + TEST_VALUE + '  ', { remember: true });
    check('CR2 value is trimmed on save', summary.hasValue === true && summary.last4 === TEST_VALUE.slice(-4),
      JSON.stringify(summary));
    const bindings = await bindingsOf(persistence);
    check('CR2 binding record has the §3.2 shape',
      bindings.length === 1
      && bindings[0].name === TEST_NAME
      && bindings[0].capabilityId === 'cred-cap'
      && bindings[0].origin === 'https://api.example.test'
      && bindings[0].pathPrefix === '/v1/tools/'
      && bindings[0].header === 'authorization'
      && bindings[0].scheme === 'Bearer'
      && bindings[0].confirmedAt === FIXED_NOW()
      && bindings[0].remember === true,
      JSON.stringify(bindings));
    const row = await secretRowOf(persistence, TEST_NAME);
    check('CR2 remembered row carries the value + identity',
      !!row && row.value === TEST_VALUE && row.name === TEST_NAME
      && row.capabilityId === 'cred-cap' && row.key === 'capcred:' + encodeURIComponent(TEST_NAME),
      JSON.stringify(row && { key: row.key, name: row.name }));
    const listed = manager.listCapabilities()[0].credentials[0];
    check('CR2 manager state is connected', listed.state === 'connected', listed.state);
    check('CR2 remembered value redacts in durable records', await redactsValue(persistence));
  }
  {
    // The not-remembered case redacts too (volatile secret).
    const { persistence, manager, service } = rig();
    await service.connect(TEST_NAME, TEST_VALUE, { remember: false });
    const row = await secretRowOf(persistence, TEST_NAME);
    check('CR2b remember:false writes no remembered row', row === null, JSON.stringify(row));
    const listed = manager.listCapabilities()[0].credentials[0];
    check('CR2b state connected without remember', listed.state === 'connected');
    check('CR2b volatile value still redacts', await redactsValue(persistence));
  }

  // ---------- CR3. remember:false clears a stale remembered row ----------
  {
    section('CR3 reconnect without remember removes the old row');
    const { persistence, service } = rig();
    await service.connect(TEST_NAME, 'old-value-aaaa', { remember: true });
    check('CR3 setup row exists', (await secretRowOf(persistence, TEST_NAME)) !== null);
    await service.connect(TEST_NAME, TEST_VALUE, { remember: false });
    check('CR3 stale remembered row removed', (await secretRowOf(persistence, TEST_NAME)) === null);
    const bindings = await bindingsOf(persistence);
    check('CR3 binding kept, remember flipped',
      bindings.length === 1 && bindings[0].remember === false, JSON.stringify(bindings));
    check('CR3 value still served', service.valueOf(TEST_NAME) === TEST_VALUE);
  }

  // ---------- CR4. reconfirm ----------
  {
    section('CR4 reconfirm: needs-reconfirm + value only');
    const { manager, service } = rig();
    let err = await rejectionOf(service.reconfirm(TEST_NAME));
    check('CR4 reconfirm refuses an unconnected credential',
      !!err && /not awaiting reconfirmation/.test(err.message), err && err.message);
    await service.connect(TEST_NAME, TEST_VALUE, { remember: true });
    err = await rejectionOf(service.reconfirm(TEST_NAME));
    check('CR4 reconfirm refuses a connected credential',
      !!err && /not awaiting reconfirmation/.test(err.message), err && err.message);
    manager.setCredentialState(TEST_NAME, 'needs-reconfirm');
    const summary = await service.reconfirm(TEST_NAME);
    check('CR4 reconfirm returns to connected', summary.state === 'connected', JSON.stringify(summary));
    check('CR4 the value survived untouched', service.valueOf(TEST_NAME) === TEST_VALUE);
    err = await rejectionOf((() => {
      // A needs-reconfirm credential WITHOUT a value (fresh page) cannot
      // be reconfirmed.
      const fresh = rig();
      fresh.manager.setCredentialState(TEST_NAME, 'needs-reconfirm');
      return fresh.service.reconfirm(TEST_NAME);
    })());
    check('CR4 reconfirm without a value is refused',
      !!err && /no value in this session/.test(err.message), err && err.message);
  }

  // ---------- CR5. disconnect ----------
  {
    section('CR5 disconnect cleans everything; idempotent');
    const { persistence, manager, service } = rig();
    await service.connect(TEST_NAME, TEST_VALUE, { remember: true });
    await service.disconnect(TEST_NAME);
    check('CR5 memory value gone', service.valueOf(TEST_NAME) === null);
    check('CR5 remembered row gone', (await secretRowOf(persistence, TEST_NAME)) === null);
    check('CR5 binding record gone', (await bindingsOf(persistence)).length === 0);
    check('CR5 state back to needs-connection',
      manager.listCapabilities()[0].credentials[0].state === 'needs-connection');
    const err = await rejectionOf(service.disconnect(TEST_NAME));
    check('CR5 disconnect is idempotent', err === null, err && String(err));
    // After a reload of the secrets store the removed value stays gone.
    await persistence.setRememberedApiKey('model-key-value', true, { provider: 'x', adapterId: 'y', dialect: 'anthropic', apiBase: 'https://api.example.test' });
    check('CR5 the removed credential value no longer redacts', await (async () => {
      await persistence.saveConversation({ id: 'probe2', note: 'v=' + TEST_VALUE });
      const rows = await persistence.loadConversations();
      return rows.some((r) => r.note === 'v=' + TEST_VALUE);
    })());
  }

  // ---------- CR6. restore ----------
  {
    section('CR6 restore: the four cases + orphans');
    // Case matrix over a SHARED persistence with successive managers.
    const persistence = new persistenceMod.PersistenceService();
    {
      // Seed: one remembered+connected, one not-remembered binding that
      // will lose its value, one orphan record.
      const m1 = newManager([credCapability(), credCapability({
        id: 'second-cap',
        credentials: [{
          name: 'SECOND_KEY', label: 'Second', description: '',
          origin: 'https://second.example.test', pathPrefix: '/v2/',
          header: 'X-Api-Key',
        }],
      })]);
      const s1 = createCredentialService({ persistence, manager: m1, now: FIXED_NOW });
      await s1.connect(TEST_NAME, TEST_VALUE, { remember: true });
      await s1.connect('SECOND_KEY', 'second-value-12345678', { remember: false });
      const bindings = await bindingsOf(persistence);
      bindings.push({
        name: 'ORPHAN_KEY', capabilityId: 'gone-cap',
        origin: 'https://gone.example.test', pathPrefix: '/g/',
        header: 'authorization', scheme: 'Bearer',
        confirmedAt: 1, remember: true,
      });
      await persistence.put('meta', { key: 'credentialBindings', bindings });
      await persistence.put('secrets', {
        key: 'capcred:' + encodeURIComponent('ORPHAN_KEY'), id: 'capcred:' + encodeURIComponent('ORPHAN_KEY'),
        value: 'orphan-value-abcdef', name: 'ORPHAN_KEY', capabilityId: 'gone-cap',
        createdAt: 't', updatedAt: 't',
      });
    }
    {
      // "Restart": fresh manager + fresh service over the SAME storage.
      const m2 = newManager([credCapability(), credCapability({
        id: 'second-cap',
        credentials: [{
          name: 'SECOND_KEY', label: 'Second', description: '',
          origin: 'https://second.example.test', pathPrefix: '/v2/',
          header: 'X-Api-Key',
        }],
      })]);
      const s2 = createCredentialService({ persistence, manager: m2 });
      await s2.restore();
      const creds = (capId) => m2.listCapabilities().find((c) => c.id === capId).credentials[0];
      check('CR6 remembered + unchanged → connected with the value',
        creds('cred-cap').state === 'connected' && s2.valueOf(TEST_NAME) === TEST_VALUE,
        creds('cred-cap').state);
      check('CR6 not-remembered + unchanged + no value → needs-connection, record kept',
        creds('second-cap').state === 'needs-connection'
        && (await bindingsOf(persistence)).some((b) => b.name === 'SECOND_KEY'));
      check('CR6 orphan record + row removed',
        !(await bindingsOf(persistence)).some((b) => b.name === 'ORPHAN_KEY')
        && (await secretRowOf(persistence, 'ORPHAN_KEY')) === null);
      check('CR6 restored values redact', await redactsValue(persistence));
    }
    {
      // Binding CHANGED (origin moved) → needs-reconfirm, value loaded.
      const m3 = newManager([credCapability({
        credentials: [{
          name: TEST_NAME, label: 'Test key', description: '',
          origin: 'https://api.example.test', pathPrefix: '/v3/tools/',
          header: 'Authorization', scheme: 'Bearer',
        }],
      })]);
      const s3 = createCredentialService({ persistence, manager: m3 });
      await s3.restore();
      const c = m3.listCapabilities()[0].credentials[0];
      check('CR6 changed binding → needs-reconfirm with the remembered value loaded',
        c.state === 'needs-reconfirm' && s3.valueOf(TEST_NAME) === TEST_VALUE,
        JSON.stringify({ state: c.state, has: s3.valueOf(TEST_NAME) !== null }));
      // Reconfirm updates the record to the CURRENT declaration.
      await s3.reconfirm(TEST_NAME);
      const record = (await bindingsOf(persistence)).find((b) => b.name === TEST_NAME);
      check('CR6 reconfirm rewrote the record to the new binding',
        record.pathPrefix === '/v3/tools/' && record.confirmedAt > 0,
        JSON.stringify(record));
    }
    {
      // No binding record at all → needs-connection.
      const persistenceFresh = new persistenceMod.PersistenceService();
      const m4 = newManager();
      const s4 = createCredentialService({ persistence: persistenceFresh, manager: m4 });
      await s4.restore();
      check('CR6 no record → needs-connection',
        m4.listCapabilities()[0].credentials[0].state === 'needs-connection');
    }
  }

  // ---------- CR7. afterReplace ----------
  {
    section('CR7 afterReplace: keep / reconfirm / drop');
    const persistence = new persistenceMod.PersistenceService();
    const unchangedDecl = {
      name: TEST_NAME, label: 'Test key', description: '',
      origin: 'https://api.example.test', pathPrefix: '/v1/tools/',
      header: 'Authorization', scheme: 'Bearer',
    };
    const changedDecl = {
      name: TEST_NAME, label: 'Test key', description: '',
      origin: 'https://api.example.test', pathPrefix: '/v9/tools/',
      header: 'Authorization', scheme: 'Bearer',
    };
    const oldTwo = [unchangedDecl, {
      name: 'DROP_KEY', label: 'Drop', description: '',
      origin: 'https://api.example.test', pathPrefix: '/v1/other/',
      header: 'Authorization', scheme: 'Bearer',
    }];

    // (a) binding unchanged → keeps the connection (value in memory).
    {
      const mOld = newManager([credCapability({ credentials: oldTwo })]);
      const sOld = createCredentialService({ persistence, manager: mOld, now: FIXED_NOW });
      await sOld.connect(TEST_NAME, TEST_VALUE, { remember: true });
      await sOld.connect('DROP_KEY', 'drop-value-123456789', { remember: true });
      const mNew = newManager([credCapability()]);
      const sNew = createCredentialService({ persistence, manager: mNew });
      await sNew.afterReplace('cred-cap', oldTwo);
      const c = mNew.listCapabilities()[0].credentials[0];
      check('CR7a unchanged binding stays connected with the value',
        c.state === 'connected' && sNew.valueOf(TEST_NAME) === TEST_VALUE,
        c.state);
      const err = await rejectionOf(sNew.afterReplace('cred-cap', oldTwo).then(() => {
        // The dropped credential was disconnected: record + row + state.
        return (async () => {
          check('CR7a dropped credential disconnected',
            !(await bindingsOf(persistence)).some((b) => b.name === 'DROP_KEY')
            && (await secretRowOf(persistence, 'DROP_KEY')) === null);
        })();
      }));
      check('CR7a afterReplace does not throw', err === null, err && String(err));
    }

    // (b) binding changed → needs-reconfirm, value preserved.
    {
      const p2 = new persistenceMod.PersistenceService();
      const mOld = newManager();
      const sOld = createCredentialService({ persistence: p2, manager: mOld, now: FIXED_NOW });
      await sOld.connect(TEST_NAME, TEST_VALUE, { remember: true });
      const mNew = newManager([credCapability({ credentials: [changedDecl] })]);
      const sNew = createCredentialService({ persistence: p2, manager: mNew });
      await sNew.afterReplace('cred-cap', [unchangedDecl]);
      const c = mNew.listCapabilities()[0].credentials[0];
      check('CR7b changed binding → needs-reconfirm, value kept',
        c.state === 'needs-reconfirm' && sNew.valueOf(TEST_NAME) === TEST_VALUE,
        JSON.stringify({ state: c.state, has: sNew.valueOf(TEST_NAME) !== null }));
    }

    // (c) new credential with NO old record → untouched (needs-connection).
    {
      const p3 = new persistenceMod.PersistenceService();
      const mNew = newManager();
      const sNew = createCredentialService({ persistence: p3, manager: mNew });
      await sNew.afterReplace('cred-cap', []);
      check('CR7c fresh credential stays needs-connection',
        mNew.listCapabilities()[0].credentials[0].state === 'needs-connection');
    }
  }

  // ---------- CR8. removeForCapability ----------
  {
    section('CR8 removeForCapability: registered and unregistered-but-bound');
    const persistence = new persistenceMod.PersistenceService();
    const m1 = newManager([
      credCapability({ id: 'cap-a' }),
      credCapability({
        id: 'cap-b',
        credentials: [{
          name: 'CAP_B_KEY', label: 'Cap B key', description: '',
          origin: 'https://b.example.test', pathPrefix: '/b/',
          header: 'Authorization', scheme: 'Bearer',
        }],
      }),
    ]);
    const s1 = createCredentialService({ persistence, manager: m1 });
    // Only cap-a's credential gets a value/binding here; cap-b keeps the
    // default state (bindings are per credential NAME).
    const bindings = await bindingsOf(persistence);
    bindings.push({
      name: 'GHOST_KEY', capabilityId: 'ghost-cap',
      origin: 'https://ghost.example.test', pathPrefix: '/g/',
      header: 'authorization', scheme: null, confirmedAt: 1, remember: true,
    });
    await persistence.put('meta', { key: 'credentialBindings', bindings });
    await persistence.put('secrets', {
      key: 'capcred:' + encodeURIComponent('GHOST_KEY'), id: 'capcred:' + encodeURIComponent('GHOST_KEY'),
      value: 'ghost-value-1234', name: 'GHOST_KEY', capabilityId: 'ghost-cap',
      createdAt: 't', updatedAt: 't',
    });
    await s1.removeForCapability('ghost-cap');
    check('CR8 unregistered capability bindings removed',
      !(await bindingsOf(persistence)).some((b) => b.name === 'GHOST_KEY')
      && (await secretRowOf(persistence, 'GHOST_KEY')) === null);
    const err = await rejectionOf(s1.removeForCapability('cap-a'));
    check('CR8 removeForCapability of a bound-less capability is a safe no-op',
      err === null, err && String(err));
  }

  // ---------- CR9. clearAll ----------
  {
    section('CR9 clearAll resets every datum');
    const { persistence, manager, service } = rig();
    await service.connect(TEST_NAME, TEST_VALUE, { remember: true });
    await service.clearAll();
    check('CR9 memory cleared', service.valueOf(TEST_NAME) === null);
    check('CR9 records cleared', (await bindingsOf(persistence)).length === 0);
    check('CR9 remembered row cleared', (await secretRowOf(persistence, TEST_NAME)) === null);
    check('CR9 state reset to needs-connection',
      manager.listCapabilities()[0].credentials[0].state === 'needs-connection');
    check('CR9 summary reports the cleared state',
      JSON.stringify(service.summary(TEST_NAME)) === JSON.stringify({ state: 'needs-connection', hasValue: false, last4: null }));
  }

  // ---------- CR10. summary ----------
  {
    section('CR10 summary last4 rules');
    const { service } = rig();
    await service.connect(TEST_NAME, 'short', { remember: false });
    check('CR10 value under 8 chars → last4 null',
      JSON.stringify(service.summary(TEST_NAME)) === JSON.stringify({ state: 'connected', hasValue: true, last4: null }),
      JSON.stringify(service.summary(TEST_NAME)));
    await service.connect(TEST_NAME, TEST_VALUE, { remember: false });
    check('CR10 last4 of a long value',
      service.summary(TEST_NAME).last4 === TEST_VALUE.slice(-4));
    check('CR10 unknown name → null state, no value',
      JSON.stringify(service.summary('NOPE_KEY')) === JSON.stringify({ state: null, hasValue: false, last4: null }));
  }

  // ---------- CR11. the credential port ----------
  {
    section('CR11 product credential port');
    const { manager, service } = rig();
    const port = createProductCredentialPort({ manager, service });
    check('CR11 a not-yet-enabled capability exposes NOTHING (enabled-only)',
      (await port.bindings()).length === 0, JSON.stringify(await port.bindings()));
    await manager.enable('cred-cap');
    check('CR11 an enabled-but-unconnected capability lists needs-connection',
      (await port.bindings()).length === 1
      && (await port.bindings())[0].state === 'needs-connection');
    await service.connect(TEST_NAME, TEST_VALUE, { remember: false });
    let b = await port.bindings();
    check('CR11 enabled capability exposes the exact binding shape',
      b.length === 1
      && JSON.stringify(Object.keys(b[0]).sort())
        === JSON.stringify(['header', 'name', 'origin', 'pathPrefix', 'scheme', 'state'])
      && b[0].name === TEST_NAME && b[0].origin === 'https://api.example.test'
      && b[0].pathPrefix === '/v1/tools/' && b[0].header === 'authorization'
      && b[0].scheme === 'Bearer' && b[0].state === 'connected',
      JSON.stringify(b));
    check('CR11 value() resolves the in-memory value', (await port.value(TEST_NAME)) === TEST_VALUE);
    await manager.disable('cred-cap');
    b = await port.bindings();
    check('CR11 a disabled capability exposes NOTHING',
      b.length === 0, JSON.stringify(b));
    await manager.enable('cred-cap');
    await service.disconnect(TEST_NAME);
    const err = await rejectionOf(port.value(TEST_NAME));
    check('CR11 value() throws (name only) for a missing value',
      !!err && /credential TEST_KEY is not available/.test(err.message)
      && !err.message.includes(TEST_VALUE), err && err.message);
  }

  // ---------- CR12. volatile secrets survive a secrets-store reload ----------
  {
    section('CR12 volatile redaction survives _loadSecrets');
    const { persistence, service } = rig();
    await service.connect(TEST_NAME, TEST_VALUE, { remember: false });
    // Any remembered-key write reloads the whole secrets store.
    await persistence.setRememberedApiKey('model-key-000', true, {
      provider: 'x', adapterId: 'y', dialect: 'anthropic', apiBase: 'https://api.example.test',
    });
    check('CR12 the volatile value still redacts after the reload',
      await redactsValue(persistence));
  }

  // ---------- CR13. injected credentialBindingChanged ----------
  {
    section('CR13 harness.credentialBindingChanged injection');
    const persistence = new persistenceMod.PersistenceService();
    const m1 = newManager();
    const s1 = createCredentialService({ persistence, manager: m1, now: FIXED_NOW });
    await s1.connect(TEST_NAME, TEST_VALUE, { remember: true });
    const m2 = newManager();
    let calls = 0;
    const s2 = createCredentialService({
      persistence, manager: m2,
      harness: { credentialBindingChanged: () => { calls++; return true; } },
    });
    await s2.restore();
    check('CR13 the injected predicate is consulted and forces needs-reconfirm',
      calls >= 1 && m2.listCapabilities()[0].credentials[0].state === 'needs-reconfirm',
      JSON.stringify({ calls, state: m2.listCapabilities()[0].credentials[0].state }));
  }

  console.log('---');
  console.log('credentials.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

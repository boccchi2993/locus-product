// ============================================================
//  CREDENTIAL SERVICE (C3, docs/C3-CREDENTIALS-MCP.md §3)
//
//  The Product-side owner of capability-credential CONNECTIONS: the
//  per-page-session in-memory key values, the durable binding records
//  (IndexedDB `meta` key `credentialBindings`), the remembered key rows
//  (`secrets` rows keyed `capcred:<name>` — kept apart from the model
//  key's `credential:` rows), and the credential STATES mirrored into
//  the harness CapabilityManager.
//
//  Pure service module: NO Vue, NO DOM, NO store.js import. Storage
//  arrives as the `persistence` port (src/persistence.js API); the
//  manager is the page CapabilityManager; `harness` supplies
//  credentialBindingChanged (defaults to the real harness export —
//  injectable for tests).
//
//  Secret discipline: a key VALUE never appears in an error message,
//  a diagnostic, or a returned record. Every value that enters memory
//  — remembered or not — is registered as a persistence volatile
//  secret, so `_redact` scrubs it from conversations, presentation
//  events and provider rows. Durable binding records carry routing
//  metadata + timestamps only, exactly the §3.2 shape.
// ============================================================

import { credentialBindingChanged as harnessCredentialBindingChanged } from './product/harness-api.js';

// Control characters (including CR/LF) can never appear in a header
// value; a value containing them is refused at connect time.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// `meta` key holding the durable binding records, and the `secrets` key
// prefix for remembered capability-credential values (kept apart from the
// model key's `credential:` prefix).
const BINDINGS_KEY = 'credentialBindings';

function secretKeyOf(name) {
  return 'capcred:' + encodeURIComponent(name);
}

export function createCredentialService({ persistence, manager, harness, now } = {}) {
  if (!persistence) throw new Error('createCredentialService requires a persistence port');
  if (!manager) throw new Error('createCredentialService requires a CapabilityManager');
  const bindingChanged = harness && typeof harness.credentialBindingChanged === 'function'
    ? harness.credentialBindingChanged
    : harnessCredentialBindingChanged;
  const clock = typeof now === 'function' ? now : () => Date.now();

  // name -> key value. THE only in-memory home of secret values. The
  // runtime reads values through the credential port, never from here.
  const values = new Map();

  // ---------- manager views ----------
  function currentDeclaration(name) {
    for (const cap of manager.listCapabilities()) {
      const c = (cap.credentials || []).find((x) => x && x.name === name);
      if (c) return { capabilityId: cap.id, credential: c };
    }
    return null;
  }

  function currentState(name) {
    const found = currentDeclaration(name);
    return found ? found.credential.state : null;
  }

  // ---------- durable binding records (meta key `credentialBindings`) ----------
  async function loadBindings() {
    const row = await persistence.get('meta', BINDINGS_KEY);
    const list = row && Array.isArray(row.bindings) ? row.bindings : [];
    return list.filter((b) => b && typeof b === 'object' && typeof b.name === 'string');
  }

  async function saveBindings(list) {
    await persistence.put('meta', { key: BINDINGS_KEY, bindings: list });
  }

  function bindingRecordFor(name, capabilityId, declaration, remember) {
    return {
      name: name,
      capabilityId: capabilityId,
      origin: declaration.origin,
      pathPrefix: declaration.pathPrefix,
      header: declaration.header,
      scheme: declaration.scheme === undefined ? null : declaration.scheme,
      confirmedAt: clock(),
      remember: !!remember,
    };
  }

  // ---------- remembered values (secrets rows `capcred:<name>`) ----------
  async function readSecret(name) {
    const row = await persistence.get('secrets', secretKeyOf(name));
    return row && typeof row.value === 'string' && row.value ? row.value : null;
  }

  async function writeSecret(name, value, capabilityId) {
    const key = secretKeyOf(name);
    const old = await persistence.get('secrets', key);
    await persistence.put('secrets', {
      key: key,
      id: key,
      value: value,
      name: name,
      capabilityId: capabilityId,
      createdAt: old && old.createdAt ? old.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async function deleteSecret(name) {
    await persistence.delete('secrets', secretKeyOf(name));
  }

  // Load a remembered value into memory (restore / reconfirm paths) and
  // keep it inside the redaction set for this page session.
  async function loadRememberedIntoMemory(name) {
    const remembered = await readSecret(name);
    if (remembered && !values.has(name)) {
      values.set(name, remembered);
      persistence.addVolatileSecret(remembered);
    }
    return remembered;
  }

  function dropValue(name) {
    const v = values.get(name);
    values.delete(name);
    if (typeof v === 'string' && v) persistence.removeVolatileSecret(v);
  }

  // ---------- C3 §3.2 — connect ----------
  // D12: remember defaults to true — an absent opts.remember persists the
  // value on this device; only an explicit false opts out.
  async function connect(name, value, opts) {
    const o = opts || {};
    const remember = o.remember === undefined ? true : !!o.remember;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed.length) {
      throw new Error('credential value must be a non-empty string');
    }
    if (CONTROL_CHARS.test(trimmed)) {
      throw new Error('credential value must not contain control characters');
    }
    const found = currentDeclaration(name);
    if (!found) {
      throw new Error('unknown credential: ' + name);
    }
    const record = bindingRecordFor(name, found.capabilityId, found.credential, remember);
    const bindings = await loadBindings();
    const next = bindings.filter((b) => b.name !== name);
    next.push(record);
    await saveBindings(next);
    // remember:false removes any stale remembered row; remember:true
    // writes (or overwrites) it. Either way the value now lives in
    // memory and in the redaction set.
    if (remember) {
      await writeSecret(name, trimmed, found.capabilityId);
    } else {
      await deleteSecret(name);
    }
    values.set(name, trimmed);
    persistence.addVolatileSecret(trimmed);
    manager.setCredentialState(name, 'connected');
    return summary(name);
  }

  // ---------- C3 §3.2 — reconfirm ----------
  // Only a needs-reconfirm credential that still holds its value can be
  // reconfirmed: the binding record is rewritten to the CURRENT
  // declaration and the state returns to connected. The value is kept —
  // the user never retypes it here.
  async function reconfirm(name) {
    const found = currentDeclaration(name);
    if (!found) {
      throw new Error('unknown credential: ' + name);
    }
    if (found.credential.state !== 'needs-reconfirm') {
      throw new Error('credential ' + name + ' is not awaiting reconfirmation (state: '
        + found.credential.state + ')');
    }
    if (!values.has(name)) {
      throw new Error('credential ' + name + ' has no value in this session; connect it again');
    }
    const previous = (await loadBindings()).find((b) => b.name === name) || null;
    const record = bindingRecordFor(name, found.capabilityId, found.credential,
      previous ? previous.remember : false);
    const bindings = await loadBindings();
    const next = bindings.filter((b) => b.name !== name);
    next.push(record);
    await saveBindings(next);
    manager.setCredentialState(name, 'connected');
    return summary(name);
  }

  // ---------- C3 §3.2 — disconnect ----------
  // Removes the value from memory, the remembered row, the binding
  // record and the redaction set. Idempotent: an unknown or already
  // removed credential is already in the requested state (the manager
  // state update is skipped when the name is no longer registered —
  // credential state is registration-scoped).
  async function disconnect(name) {
    dropValue(name);
    await deleteSecret(name);
    const bindings = await loadBindings();
    const next = bindings.filter((b) => b.name !== name);
    if (next.length !== bindings.length) await saveBindings(next);
    if (currentState(name) !== null) {
      manager.setCredentialState(name, 'needs-connection');
    }
  }

  // ---------- boot restore (after capabilityPackages.loadInstalled) ----------
  // Four cases per registered credential (C3 §3.2):
  //   no binding record                          → needs-connection
  //   record, binding changed                    → needs-reconfirm (remembered value still loaded)
  //   record, unchanged, remembered value loaded → connected
  //   record, unchanged, no value                → needs-connection (record kept)
  // Orphan records (credential no longer registered) are deleted with
  // their remembered rows.
  async function restore() {
    const bindings = await loadBindings();
    const byName = new Map(bindings.map((b) => [b.name, b]));
    const known = new Set();
    for (const cap of manager.listCapabilities()) {
      for (const c of (cap.credentials || [])) {
        known.add(c.name);
        const record = byName.get(c.name) || null;
        if (!record) {
          if (c.state !== 'needs-connection') manager.setCredentialState(c.name, 'needs-connection');
          continue;
        }
        if (record.remember) await loadRememberedIntoMemory(c.name);
        if (bindingChanged(record, c)) {
          manager.setCredentialState(c.name, 'needs-reconfirm');
        } else if (values.has(c.name)) {
          manager.setCredentialState(c.name, 'connected');
        } else if (c.state !== 'needs-connection') {
          manager.setCredentialState(c.name, 'needs-connection');
        }
      }
    }
    const orphans = bindings.filter((b) => !known.has(b.name));
    if (orphans.length) {
      for (const o of orphans) {
        dropValue(o.name);
        await deleteSecret(o.name);
      }
      await saveBindings(bindings.filter((b) => known.has(b.name)));
    }
  }

  // ---------- version replacement (commit 'replace') ----------
  // Called AFTER the new version registered. Per NEW credential:
  //   binding record exists and still matches the NEW declaration
  //     → keep; a value in memory (just loaded when remembered) means
  //       connected, no value means needs-connection.
  //   binding record exists but the binding changed
  //     → needs-reconfirm, the value is preserved.
  //   no record → untouched (stays the fresh needs-connection).
  // Credentials the OLD version declared and the new one dropped are
  // disconnected (value, remembered row, record).
  async function afterReplace(capabilityId, oldCredentials) {
    const cap = manager.listCapabilities().find((c) => c.id === capabilityId) || null;
    const newCredentials = cap ? (cap.credentials || []) : [];
    const newNames = new Set(newCredentials.map((c) => c.name));
    const bindings = await loadBindings();
    const byName = new Map(bindings.map((b) => [b.name, b]));
    for (const c of newCredentials) {
      const record = byName.get(c.name) || null;
      if (!record) continue;
      if (record.remember) await loadRememberedIntoMemory(c.name);
      if (bindingChanged(record, c)) {
        manager.setCredentialState(c.name, 'needs-reconfirm');
      } else if (values.has(c.name)) {
        manager.setCredentialState(c.name, 'connected');
      } else if (c.state !== 'needs-connection') {
        manager.setCredentialState(c.name, 'needs-connection');
      }
    }
    for (const old of (Array.isArray(oldCredentials) ? oldCredentials : [])) {
      if (old && typeof old.name === 'string' && !newNames.has(old.name)) {
        await disconnect(old.name);
      }
    }
  }

  // ---------- uninstall ----------
  // Every credential of the capability — from the live manager view AND
  // from durable records (a boot-skipped package may hold bindings
  // without being registered) — is disconnected.
  async function removeForCapability(capabilityId) {
    const names = new Set();
    const cap = manager.listCapabilities().find((c) => c.id === capabilityId) || null;
    if (cap) for (const c of (cap.credentials || [])) names.add(c.name);
    for (const b of await loadBindings()) {
      if (b && b.capabilityId === capabilityId && typeof b.name === 'string') names.add(b.name);
    }
    for (const name of names) await disconnect(name);
  }

  // ---------- reset-all-data ----------
  // Clears memory, every binding record, every `capcred:` row and the
  // redaction set. Registered credentials return to needs-connection.
  async function clearAll() {
    for (const v of values.values()) {
      if (typeof v === 'string' && v) persistence.removeVolatileSecret(v);
    }
    values.clear();
    const bindings = await loadBindings();
    for (const b of bindings) await deleteSecret(b.name);
    await saveBindings([]);
    for (const cap of manager.listCapabilities()) {
      for (const c of (cap.credentials || [])) {
        if (c.state !== 'needs-connection') manager.setCredentialState(c.name, 'needs-connection');
      }
    }
  }

  // ---------- UI summary (C3 §3.2: only the last 4 characters) ----------
  function summary(name) {
    const found = currentDeclaration(name);
    const v = typeof values.get(name) === 'string' ? values.get(name) : null;
    return {
      state: found ? found.credential.state : null,
      hasValue: v !== null,
      last4: v && v.length >= 8 ? v.slice(-4) : null,
    };
  }

  // Read-only view of the durable binding record (§3.2 shape) for the
  // needs-reconfirmation dialog: the OLD binding lines come from here,
  // the new ones from the live declaration. Metadata only — never a
  // value. Null when no record exists.
  async function bindingRecord(name) {
    const record = (await loadBindings()).find((b) => b.name === name);
    if (!record) return null;
    return {
      name: record.name,
      origin: record.origin,
      pathPrefix: record.pathPrefix,
      header: record.header,
      scheme: record.scheme === undefined ? null : record.scheme,
      confirmedAt: record.confirmedAt,
      remember: !!record.remember,
    };
  }

  // Raw value accessor for the credential port (never a UI surface).
  function valueOf(name) {
    const v = values.get(name);
    return typeof v === 'string' ? v : null;
  }

  return {
    connect, reconfirm, disconnect, restore,
    afterReplace, removeForCapability, clearAll,
    summary, valueOf, bindingRecord,
  };
}

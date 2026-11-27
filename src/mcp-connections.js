// ============================================================
//  MCP CONNECTION SERVICE (C3 phase-2, docs/C3-MCP-STREAMABLE-HTTP.md §5)
//
//  The Product-side owner of MCP server CONNECTIONS: the durable
//  connection records (IndexedDB `meta` key `mcpConnections`, beside
//  `credentialBindings`), the connect / disconnect decisions, the boot
//  restore, and the version-replacement / relock / uninstall /
//  reset reconciliations (§5.3, §5.4, §5.7).
//
//  Pure service module: NO Vue, NO DOM, NO store.js import. Storage
//  arrives as the `persistence` port (src/persistence.js API); the
//  manager is the page CapabilityManager; `credentials` is the C3
//  credential service (src/credentials.js).
//
//  A connection record is the user's decision "this server, exactly as
//  declared at confirmation time" (§5.1 — 以确认时为准). It carries NO
//  secret: the token stays in the credential service (D3/D12), the
//  session id lives only in the future per-task MCP port's memory.
//  After any field of the declaration (url / auth / credential) changes,
//  the record no longer matches and the server returns to
//  needs-connection; the comparison is plain string equality because
//  package validation pins every url to exactly one canonical spelling.
//
//  State discipline: every harness state write goes through the SAME
//  entry the store uses (manager.setMcpState — setMcpConnectionState is
//  store.setMcpConnectionState's call; an injectable `setState` lets the
//  store pass its own wrapper so the UI projection stays in sync). No
//  second harness write surface is created. Legacy (no-endpoint) entries
//  are permanently `unavailable` with the in-memory reason `no-endpoint`
//  (§3.5) — they never take part in connection.
// ============================================================

// `meta` key holding the durable connection records.
const CONNECTIONS_KEY = 'mcpConnections';

export function createMcpConnectionService({ persistence, manager, credentials, setState, now } = {}) {
  if (!persistence) throw new Error('createMcpConnectionService requires a persistence port');
  if (!manager) throw new Error('createMcpConnectionService requires a CapabilityManager');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const credentialService = credentials || null;
  // The store's setMcpConnectionState when injected (keeps the UI
  // projection in sync); manager.setMcpState otherwise — the same
  // underlying harness write either way.
  const writeState = typeof setState === 'function'
    ? setState
    : (id, state) => manager.setMcpState(id, state);

  // In-memory "most recent failure reason" per server (§5.5) — never
  // persisted, never part of the harness state table.
  const reasons = new Map(); // serverId -> lowercase stable token

  // ---------- manager views ----------
  // The declaring capability of one server id (server ids are unique
  // across all installed capabilities — C3 phase-2 §3.4).
  function currentDeclaration(serverId) {
    for (const cap of manager.listCapabilities()) {
      const m = (cap.mcps || []).find((x) => x && x.id === serverId);
      if (m) return { capabilityId: cap.id, mcp: m };
    }
    return null;
  }

  function declaredServers() {
    const out = [];
    for (const cap of manager.listCapabilities()) {
      for (const m of (cap.mcps || [])) {
        if (m && typeof m.id === 'string') out.push({ capabilityId: cap.id, mcp: m });
      }
    }
    return out;
  }

  function credentialStateOf(name) {
    if (!credentialService || typeof credentialService.summary !== 'function') return null;
    const s = credentialService.summary(name);
    return s ? s.state : null;
  }

  function hasCredentialValue(name) {
    if (!credentialService || typeof credentialService.summary !== 'function') return false;
    const s = credentialService.summary(name);
    return !!s && s.hasValue === true;
  }

  // "以确认时为准": the record matches when every declared endpoint
  // field is string-equal to the current declaration.
  function recordMatches(record, mcp) {
    return !!record && !!mcp && mcp.url !== undefined
      && record.url === mcp.url
      && record.auth === mcp.auth
      && record.credential === mcp.credential;
  }

  // ---------- durable connection records (meta key `mcpConnections`) ----------
  async function loadRecords() {
    const row = await persistence.get('meta', CONNECTIONS_KEY);
    const list = row && Array.isArray(row.connections) ? row.connections : [];
    return list.filter((r) => r && typeof r === 'object' && typeof r.serverId === 'string');
  }

  async function saveRecords(list) {
    await persistence.put('meta', { key: CONNECTIONS_KEY, connections: list });
  }

  function recordFor(serverId, capabilityId, mcp) {
    return {
      serverId: serverId,
      capabilityId: capabilityId,
      url: mcp.url,
      auth: mcp.auth,
      credential: mcp.credential,
      confirmedAt: clock(),
    };
  }

  // ---------- C3 phase-2 §5.2 — connect ----------
  // The user's three-in-one decision: connect the token (when provided),
  // write the record, flip the state to connected. NO network: connected
  // means "user decided, binding valid" — the handshake belongs to the
  // first `mcp` command.
  async function connect(serverId, opts) {
    const o = opts || {};
    const found = currentDeclaration(serverId);
    if (!found) throw new Error('unknown server: ' + serverId);
    const { capabilityId, mcp } = found;
    if (mcp.url === undefined) {
      throw new Error('server ' + serverId + ' declares no endpoint (unavailable); update its package');
    }
    if (!credentialService) {
      throw new Error('the credential service is unavailable; cannot connect server ' + serverId);
    }
    const token = typeof o.token === 'string' ? o.token.trim() : '';
    if (token.length) {
      // D12: remember defaults to true inside the credential service.
      await credentialService.connect(mcp.credential, token, { remember: o.remember });
    } else if (!hasCredentialValue(mcp.credential)) {
      throw new Error('credential ' + mcp.credential + ' is not connected; provide its token to connect server ' + serverId);
    }
    const records = await loadRecords();
    const next = records.filter((r) => r.serverId !== serverId);
    next.push(recordFor(serverId, capabilityId, mcp));
    await saveRecords(next);
    reasons.delete(serverId);
    writeState(serverId, 'connected');
    return record(serverId);
  }

  // ---------- C3 phase-2 §5.7 — disconnect ----------
  // Removes the record and flips the state; the TOKEN is untouched
  // (other servers may still use the credential). Idempotent.
  async function disconnect(serverId) {
    const records = await loadRecords();
    const next = records.filter((r) => r.serverId !== serverId);
    if (next.length !== records.length) await saveRecords(next);
    reasons.delete(serverId);
    if (currentDeclaration(serverId)) {
      writeState(serverId, 'needs-connection');
    }
  }

  // ---------- boot restore (§5.3) — after packages are loaded ----------
  //   legacy entry (no url)          → unavailable, reason no-endpoint
  //   record, matches, credential connected        → connected
  //   record, matches, credential otherwise       → needs-connection
  //   record, mismatched, or no record            → needs-connection
  // Records of servers no longer declared anywhere are orphans and are
  // deleted (the same cleanup rule the credential service applies).
  async function restore() {
    const records = await loadRecords();
    const byServer = new Map(records.map((r) => [r.serverId, r]));
    const declared = declaredServers();
    const known = new Set(declared.map((d) => d.mcp.id));
    for (const { mcp } of declared) {
      if (mcp.url === undefined) {
        reasons.set(mcp.id, 'no-endpoint');
        if (mcp.state !== 'unavailable') writeState(mcp.id, 'unavailable');
        continue;
      }
      const record = byServer.get(mcp.id) || null;
      if (recordMatches(record, mcp)
        && credentialStateOf(mcp.credential) === 'connected') {
        reasons.delete(mcp.id);
        if (mcp.state !== 'connected') writeState(mcp.id, 'connected');
      } else {
        if (mcp.state !== 'needs-connection') writeState(mcp.id, 'needs-connection');
      }
    }
    const orphans = records.filter((r) => !known.has(r.serverId));
    if (orphans.length) {
      await saveRecords(records.filter((r) => known.has(r.serverId)));
    }
  }

  // ---------- version replacement (§5.7; commit 'replace' + rollback) ----------
  // Called AFTER the new version registered. Per NEW server:
  //   legacy entry                    → unavailable (no-endpoint)
  //   record exists and matches       → keep; connected when its
  //                                     credential is connected, else
  //                                     needs-connection
  //   record exists but mismatches,
  //   or no record                    → needs-connection (new servers are
  //                                     then handled by the import
  //                                     dialog's connect step, §5.2)
  // Servers of the OLD version the new one dropped lose their records.
  async function afterReplace(capabilityId, oldMcps) {
    const records = await loadRecords();
    const byServer = new Map(records.map((r) => [r.serverId, r]));
    const cap = manager.listCapabilities().find((c) => c.id === capabilityId) || null;
    const newMcps = cap ? (cap.mcps || []) : [];
    const newIds = new Set(newMcps.map((m) => m.id));
    for (const mcp of newMcps) {
      if (mcp.url === undefined) {
        reasons.set(mcp.id, 'no-endpoint');
        if (mcp.state !== 'unavailable') writeState(mcp.id, 'unavailable');
        continue;
      }
      const record = byServer.get(mcp.id) || null;
      if (recordMatches(record, mcp)
        && credentialStateOf(mcp.credential) === 'connected') {
        reasons.delete(mcp.id);
        if (mcp.state !== 'connected') writeState(mcp.id, 'connected');
      } else if (mcp.state !== 'needs-connection') {
        writeState(mcp.id, 'needs-connection');
      }
    }
    // Records of dropped servers: named by the captured old declarations,
    // plus anything still attributing itself to this capability (a
    // boot-skipped old version left no live manager view to capture).
    const dropped = new Set();
    for (const old of (Array.isArray(oldMcps) ? oldMcps : [])) {
      if (old && typeof old.id === 'string' && !newIds.has(old.id)) dropped.add(old.id);
    }
    for (const r of records) {
      if (r.capabilityId === capabilityId && !newIds.has(r.serverId)) dropped.add(r.serverId);
    }
    if (dropped.size) {
      for (const id of dropped) {
        reasons.delete(id);
        byServer.delete(id);
      }
      await saveRecords([...byServer.values()]);
    }
  }

  // ---------- integrity relock (§5.4; acceptMismatch) ----------
  // The package's bytes changed after the original confirmation, so its
  // servers' endpoints need re-confirmation: every declared server goes
  // needs-connection while the records are KEPT (shown as "the last
  // connection" — an unchanged declaration reconnects with one click).
  // Legacy entries stay unavailable (no-endpoint is permanent).
  async function afterRelock(capabilityId) {
    const cap = manager.listCapabilities().find((c) => c.id === capabilityId) || null;
    for (const mcp of (cap ? (cap.mcps || []) : [])) {
      if (mcp.url === undefined) continue;
      if (mcp.state !== 'needs-connection') writeState(mcp.id, 'needs-connection');
    }
  }

  // ---------- uninstall (§5.7) ----------
  // Every record of the capability — by attribution and by the live
  // manager view (identical while registered; uninstall calls this
  // BEFORE the unregister) — is deleted and the still-declared servers
  // return to needs-connection.
  async function removeForCapability(capabilityId) {
    const records = await loadRecords();
    const declaredIds = new Set(
      declaredServers().filter((d) => d.capabilityId === capabilityId).map((d) => d.mcp.id));
    const keep = [];
    for (const r of records) {
      const mine = r.capabilityId === capabilityId || declaredIds.has(r.serverId);
      if (!mine) { keep.push(r); continue; }
      reasons.delete(r.serverId);
      if (declaredIds.has(r.serverId)) writeState(r.serverId, 'needs-connection');
    }
    if (keep.length !== records.length) await saveRecords(keep);
  }

  // ---------- reset-all-data (§5.7) ----------
  // Wipes every record and every in-memory reason; declared connectable
  // servers return to needs-connection, legacy entries to unavailable.
  async function clearAll() {
    reasons.clear();
    await saveRecords([]);
    for (const { mcp } of declaredServers()) {
      if (mcp.url === undefined) {
        reasons.set(mcp.id, 'no-endpoint');
        if (mcp.state !== 'unavailable') writeState(mcp.id, 'unavailable');
      } else if (mcp.state !== 'needs-connection') {
        writeState(mcp.id, 'needs-connection');
      }
    }
  }

  // ---------- read-only views ----------
  // The durable record (metadata only — §5.1 shape) or null.
  async function record(serverId) {
    const r = (await loadRecords()).find((x) => x.serverId === serverId);
    if (!r) return null;
    return {
      serverId: r.serverId,
      capabilityId: r.capabilityId,
      url: r.url,
      auth: r.auth,
      credential: r.credential,
      confirmedAt: r.confirmedAt,
    };
  }

  // The most recent failure reason (in-memory only, §5.5) or null.
  function reason(serverId) {
    return reasons.get(serverId) || null;
  }

  // Failure reporting seam for the future per-task MCP port (§5.5): a
  // transient failure records its stable lowercase token WITHOUT
  // touching any persistent state; a recovery clears it. Never a harness
  // state write.
  function setReason(serverId, reasonToken) {
    if (reasonToken === null || reasonToken === undefined) reasons.delete(serverId);
    else reasons.set(serverId, String(reasonToken));
  }

  return {
    connect, disconnect, restore,
    afterReplace, afterRelock, removeForCapability, clearAll,
    record, reason, setReason,
  };
}

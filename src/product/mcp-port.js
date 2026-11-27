// ============================================================
//  PRODUCT MCP PORT (C3 phase-2, docs/C3-MCP-STREAMABLE-HTTP.md §10.3)
//
//  The per-task port the runtime's `mcp` command consumes through the
//  tool-execution context (context.mcp, beside credentials). ONE port
//  per task, built by the store after the task environment exists:
//
//    servers()  → the task's server snapshot (the set frozen at task
//                 start) with LIVE states read at call time. A server is
//                 only ever reported 'connected' when its durable
//                 connection record still matches the CURRENT declaration
//                 (§5.6.3 — "以确认时为准" re-checked on every read, not
//                 just at connect time); legacy entries (no endpoint)
//                 are unavailable (no-endpoint) and never connectable.
//    setState() → the client's result-triggered transitions (§5.3),
//                 validated and routed to the store's ONE harness write
//                 path; transient tokens never become harness states.
//    noteFailure() / noteSuccess() → the §5.5 in-memory transient note
//                 (the UI's "Unreachable — will retry on next use"),
//                 routed to the connection service's reason map. Never
//                 persisted, never a state.
//    elicit()   → the §8.4 harness ApprovalController 'elicitation'
//                 kind. The form answers live in the decision's content
//                 only — they never touch the store, storage or the
//                 conversation. beforeToolCall is deliberately ABSENT:
//                 the first version uses the runtime's default behavior
//                 (allow — C3 §7).
//
//  Pure adapter: NO Vue, NO DOM, NO store.js import. The token NEVER
//  appears here: the runtime resolves values through the existing
//  credential port (context.credentials.value).
// ============================================================

export function createProductMcpPort({
  snapshot,        // the task's frozen mcp snapshot entries [{ id, displayName, url?, auth?, credential? }]
  capabilityName,  // (serverId) → the owning capability name pinned at task start
  liveState,       // (serverId) → the manager's live state or null
  record,          // (serverId) → Promise<record|null> (connection service)
  reason,          // (serverId) → the in-memory transient token or null
  setReason,       // (serverId, token|null) → void (connection service)
  setState,        // (serverId, state, reason?) → void (the store's ONE write path)
  approvals,       // the page ApprovalController (elicitation kind)
  conversationId,  // the running conversation's id (identity metadata)
  taskGeneration,  // the pinned session generation (identity metadata)
} = {}) {
  if (!Array.isArray(snapshot)) {
    throw new Error('createProductMcpPort requires the task server snapshot array');
  }
  if (typeof setState !== 'function') {
    throw new Error('createProductMcpPort requires a setState write path');
  }
  if (!approvals || typeof approvals.request !== 'function') {
    throw new Error('createProductMcpPort requires the ApprovalController');
  }

  const HARNESS_MCP_STATES = ['connected', 'needs-connection', 'unavailable'];

  // The runtime's servers() read: the SET comes from the snapshot, the
  // state is read live, and 'connected' additionally requires the
  // durable record to still match the current declaration (§5.6.3).
  async function servers() {
    const out = [];
    for (const entry of snapshot) {
      if (!entry || typeof entry.id !== 'string') continue;
      let state = typeof liveState === 'function' ? liveState(entry.id) : null;
      if (!HARNESS_MCP_STATES.includes(state)) state = 'needs-connection';
      let failure = typeof reason === 'function' ? reason(entry.id) : null;
      if (entry.url === undefined || entry.url === null) {
        // A legacy entry can never take part in connection (§3.5).
        state = 'unavailable';
        failure = failure || 'no-endpoint';
      } else if (state === 'connected') {
        let rec = null;
        try {
          rec = typeof record === 'function' ? await record(entry.id) : null;
        } catch (e) { rec = null; }
        const matches = !!rec
          && rec.url === entry.url
          && rec.auth === entry.auth
          && rec.credential === entry.credential;
        if (!matches) state = 'needs-connection';
      }
      out.push({
        id: entry.id,
        displayName: entry.displayName || entry.id,
        description: entry.description || null,
        url: entry.url === undefined ? null : entry.url,
        auth: entry.auth === undefined ? null : entry.auth,
        credential: entry.credential === undefined ? null : entry.credential,
        state,
        reason: failure || null,
      });
    }
    return out;
  }

  // The client's result-triggered transitions. Only the three harness
  // states are written; anything else is refused (fail closed, nothing
  // written) — the harness state table never learns a fourth state.
  function setStateValidated(serverId, state, reasonToken) {
    if (!HARNESS_MCP_STATES.includes(state)) return;
    setState(serverId, state, reasonToken);
  }

  // §5.5 transient notes: in-memory only, routed to the connection
  // service's reason map. A null token clears the note (recovery).
  function noteFailure(serverId, token) {
    if (typeof setReason !== 'function') return;
    setReason(serverId, typeof token === 'string' && token ? token : 'unreachable');
  }
  function noteSuccess(serverId) {
    if (typeof setReason !== 'function') return;
    setReason(serverId, null);
  }

  // §8.4: the port's elicitation endpoint IS one approval request of the
  // harness 'elicitation' kind. The action summary is FIXED harness text
  // (never server content — the message travels in the elicitation
  // payload and the card renders it from there). The decision maps back
  // to the runtime's action shape; the harness's cancelled outcome (task
  // signal, Escape, session boundary) maps to action 'cancel'.
  async function elicit(req, opts) {
    const o = req && typeof req === 'object' ? req : {};
    const server = snapshot.find((entry) => entry && entry.id === o.server?.id);
    if (!server?.url) return { action: 'cancel' };
    const owner = typeof capabilityName === 'function' ? capabilityName(server.id) : null;
    const decision = await approvals.request({
      kind: 'elicitation',
      action: { summary: 'An MCP server is asking for form input' },
      resource: {
        type: 'mcp-elicitation',
        label: [owner, server.displayName || server.id, server.url].filter(Boolean).join(' · '),
      },
      elicitation: {
        message: typeof o.message === 'string' ? o.message : '',
        requestedSchema: o.requestedSchema && typeof o.requestedSchema === 'object'
          ? o.requestedSchema : {},
      },
      conversationId: conversationId === undefined ? null : conversationId,
      taskGeneration: taskGeneration === undefined ? null : taskGeneration,
    }, opts);
    if (!decision || typeof decision !== 'object') return { action: 'cancel' };
    if (decision.outcome === 'accept') {
      return { action: 'accept', content: decision.content === undefined ? {} : decision.content };
    }
    if (decision.outcome === 'decline') return { action: 'decline' };
    return { action: 'cancel' }; // 'cancel' and the harness's 'cancelled'
  }

  return { servers, setState: setStateValidated, noteFailure, noteSuccess, elicit };
}

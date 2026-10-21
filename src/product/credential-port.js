// ============================================================
//  PRODUCT CREDENTIAL PORT (C3, docs/C3-CREDENTIALS-MCP.md §4.2)
//
//  The narrow port the runtime's NetworkRuntime consumes through the
//  tool-execution context (injected beside `authorization`):
//
//    bindings()  → [{ name, origin, pathPrefix, header, scheme, state }]
//                  metadata only, ONLY for ENABLED capabilities; the
//                  header keeps the declaration's spelling (the runtime
//                  compares lowercased); scheme is 'Bearer' or null.
//    value(name) → the in-memory key value; a missing value throws
//                  (the runtime maps it to network_credential_unavailable).
//
//  Pure adapter: NO Vue, NO DOM, NO store.js, no storage. The manager is
//  the page CapabilityManager; the service is the src/credentials.js
//  instance holding the values. Both methods may return Promises.
// ============================================================

export function createProductCredentialPort({ manager, service } = {}) {
  if (!manager) {
    throw new Error('createProductCredentialPort requires a CapabilityManager');
  }
  if (!service || typeof service.valueOf !== 'function') {
    throw new Error('createProductCredentialPort requires a credential service');
  }
  return {
    async bindings() {
      const out = [];
      for (const cap of manager.listCapabilities()) {
        if (!cap.enabled) continue; // disabled capabilities expose nothing
        for (const c of (cap.credentials || [])) {
          out.push({
            name: c.name,
            origin: c.origin,
            pathPrefix: c.pathPrefix,
            header: c.header,
            scheme: c.scheme === undefined ? null : c.scheme,
            state: c.state,
          });
        }
      }
      return out;
    },
    async value(name) {
      const v = service.valueOf(name);
      if (typeof v !== 'string' || !v.length) {
        // Name-only message: the VALUE never appears in any error.
        throw new Error('credential ' + String(name) + ' is not available');
      }
      return v;
    },
  };
}

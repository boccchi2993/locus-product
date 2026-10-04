// ============================================================
//  TELEMETRY
//  In-memory execution telemetry. Every tool execution is recorded
//  here; inspect via the "log" panel, the `telemetry` command, or
//  window.__telemetry in the console.
//
//  M3c integration (agent D): real ES module. Consumers import the
//  named exports (tools.js, ContextRail.vue) — no production code
//  reads the classic globals anymore. The page-level handles STAY as
//  documented observability accessors only: window.__telemetry (the
//  live records array, also the e2e evidence read) and the
//  globalThis.Telemetry alias the e2e suites read in page context.
//  They are not load-bearing for any production import.
// ============================================================

// Real UTF-8 byte length of a string (NOT String.length, which counts
// UTF-16 code units — e.g. "你好" is 6 bytes, not 2).
export function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text)).byteLength;
}

export const Telemetry = {
  records: [],

  record(entry) {
    const rec = Object.assign({
      ts: new Date().toISOString(),
      tool: '',
      backend: 'browser',
      duration_ms: 0,
      success: false,
      input_bytes: 0,
      output_bytes: 0,
      error: null,
    }, entry);
    this.records.push(rec);
    // Trim in place: window.__telemetry holds a reference to this exact
    // array and must never be detached by reassignment.
    if (this.records.length > 500) this.records.splice(0, this.records.length - 500);
    // M2b (repository split): the Product UI refresh hook
    // (renderDebugPanel) is GONE — the sink never reaches back into a
    // presentation layer. The Product subscribes/projections read the
    // records (store.telemetryVersion bump on tool_result); a core must
    // never depend on a renderer global.
    return rec;
  },
};

if (typeof window !== 'undefined') window.__telemetry = Telemetry.records;

// Page-level observability handle (e2e evidence reads, console access).
// Production consumers import { Telemetry } — this publish is not part
// of any module lexical chain.
globalThis.Telemetry = Telemetry;
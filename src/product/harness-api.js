// ============================================================
//  PRODUCT → HARNESS public API (M3c switch, agent B).
//
//  The ONLY import path from Product code to locus-harness
//  (docs/M3C-PARALLEL-HANDOFF.md §3, frozen shape). Pure re-export
//  of the package's public entry: no wrappers, no copied algorithms,
//  no global registration, no extra exports.
// ============================================================
export * from 'locus-harness';

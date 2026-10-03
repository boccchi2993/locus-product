// ============================================================
//  PRODUCT RUNTIME API — the ONLY import path from product code to
//  the locus-runtime core (M3c parallel handoff §3, frozen shape).
//
//  Pure re-export layer: no global registration (globalThis/window
//  publishes), no initialization, no wrappers, no compat shims, no
//  copied algorithms, no extra exports. Every product import of core
//  code goes through this file — no `locus-runtime/…` specifier may
//  appear anywhere else in product code.
//
//  Export surface (locus-runtime @ 2435a57, verified against the
//  installed package's real entries — disjoint surfaces, so `export *`
//  is collision-free):
//    locus-runtime            createRuntime, createWorkspace,
//                             createMemoryWorkspace, shellCommandNames
//    locus-runtime/workspace  LocalDirectoryWorkspace, OPFSWorkspace,
//                             WorkspaceAdapter, ensureWorkspacePermission,
//                             normalizeWorkspacePath, vfsError
//    locus-runtime/worker-assets → the `runtimeWorkerAssets` namespace
//                             (PY_WORKER_SOURCE, GREP_WORKER_SOURCE)
//  Consumers read worker assets as
//    runtimeWorkerAssets.PY_WORKER_SOURCE / .GREP_WORKER_SOURCE
//  so `createRuntime({ workerAssets })` keeps its shape.
//
//  Not exported here (verified absent from the package entry):
//  `utf8ByteLength` — the runtime keeps it internal; Product tools.js
//  continues to consume the Product-owned copy in src/telemetry.js
//  (M3C-PARALLEL-HANDOFF §6 item 6).
// ============================================================

export * from 'locus-runtime';
export * from 'locus-runtime/workspace';
export * as runtimeWorkerAssets from 'locus-runtime/worker-assets';

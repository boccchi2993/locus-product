// The 23 storage behavior checks of the M3c storage-adapter browser
// gates — ONE table, TWO consumers, so the gates cannot drift:
//   - tests/e2e-m3c-storage-adapters.cjs (SOURCE-ESM gate)
//   - tests/e2e-m3c-storage-built.cjs    (PACKAGED-BUILD gate)
// The assertions are the original e2e-m3c-storage-adapters.cjs table
// (real IndexedDB/OPFS, REAL harness identity/replay/skill boundaries),
// kept verbatim. B0 additionally reads the binding provenance the shared
// engine records (a strengthening, never a weakening) — neither gate may
// weaken any check here.
'use strict';

function runStorageChecks(check, bootData, r) {
  const results = r || {};
  check('B0 all five converted modules imported over the two API files',
    !!bootData
    && !!bootData.modules
    && bootData.modules.runtimeApi === 'object'
    && bootData.modules.harnessApi === 'object'
    && bootData.modules.persistence === 'object'
    && bootData.modules.attachments === 'object'
    && bootData.modules.extensions === 'object'
    && bootData.modules.capabilityPackage === 'object'
    && bootData.modules.ConversationHistoryWorkspace === 'function',
    JSON.stringify(bootData));
  check('B1 REAL IndexedDB: schema v3 opened, health healthy',
    !!bootData && bootData.persistenceMode === 'indexeddb' && bootData.health === 'healthy',
    JSON.stringify(bootData));
  check('B2 REAL OPFS available', !!bootData && bootData.opfsAvailable === true);

  check('P1 settings round trip over REAL IndexedDB', results.p && results.p.settingsOk === true, JSON.stringify(results.p));
  check('P2 remembered credentials keyed through the REAL harness identity', results.p && results.p.rememberedOk === true);
  check('P3 deleteConversation atomically removes frames over REAL IndexedDB',
    !!results.p && results.p.framesBefore === 1 && results.p.deleted === true && results.p.framesAfter === 0 && results.p.conversationsAfter === 0,
    JSON.stringify(results.p));

  check('O1 home skeleton created in REAL OPFS', results.o && results.o.error === undefined && results.o.pluginRoundTrip === true, JSON.stringify(results.o));
  check('O2 privileged plugin write/read round-trips REAL OPFS bytes', !!results.o && results.o.pluginRoundTrip === true && results.o.pluginGone === true);
  check('O3 attachment ingest is durable (REAL IDB meta + OPFS bytes)', !!results.o && results.o.attachmentDurable === true);
  check('O4 resolveForWire returns the exact ingested bytes', !!results.o && results.o.wireOk === true);
  check('O5 corrupted durable bytes refused with hash_mismatch', !!results.o && results.o.corruptReason === 'hash_mismatch', String(results.o && results.o.corruptReason));
  check('O6 clearAttachments removes the durable bytes', !!results.o && results.o.cleared === true);

  check('C1 REAL fixture project validates', results.c && results.c.validateOk === true, JSON.stringify(results.c));
  check('C2 REAL fixture project builds a bundle', !!results.c && results.c.buildOk === true);
  check('C3 lock hash = sha256Hex = crypto.subtle oracle over exact bytes', !!results.c && results.c.hashAgreesWithSubtle === true);
  check('C4 inspectBundle reports the valid bundle', !!results.c && results.c.inspectValid === true);

  check('R1 persistence validators ARE the harness entry functions', results.r && results.r.identity === true, JSON.stringify(results.r));
  check('R2 the REAL validator accepts a valid prefix in the browser', !!results.r && results.r.validAccepted === true);
  check('R3 corrupted prefix rejected with session_identity_mismatch', !!results.r && results.r.corruptedCode === 'session_identity_mismatch');

  check('S1 harness skill-instance path identity holds in the browser', results.s && results.s.pathIdentity === true, JSON.stringify(results.s));
  check('S2 the harness-owned install marker is refused for mutation', !!results.s && results.s.markerWriteCode === 'skill_mutation_boundary');
  check('S3 skill mutation without an approval port fails closed', !!results.s && results.s.noApprovalsCode === 'skill_mutation_no_task');
  check('S4 the shared 256 KiB skill bound is the harness value', !!results.s && results.s.bound === 262144);
}

module.exports = { runStorageChecks };

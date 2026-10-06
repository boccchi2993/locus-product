// Browser-gate suite registry + requested-suite resolution.
// Split out of run-browser-gates.cjs (m3c review A) so the orchestrator
// test can assert the registry shape and the unknown-suite refusal without
// spawning anything.
//
// New browser suites are appended here ONLY together with the rest of
// their integration (owner: m3c-D / M4 follow-ups) — the orchestrator
// must never invent suite names.
const SUITES = [
  'e2e-ui.cjs',
  'e2e-responsive.cjs',
  'e2e-grep.cjs',
  'e2e-approval.cjs',
  'e2e-network.cjs',
  'e2e-capabilities.cjs',
  'e2e-image.cjs',
  'e2e-skill-instances.cjs',
  'e2e-persistence.cjs',
  'e2e-wire.cjs',
  'e2e-product-joint.cjs',
  'e2e-runtime-host.cjs',
  'e2e-harness-host.cjs',
  'e2e-m3c-storage-adapters.cjs',
  // Review-round registrations (D wiring): C's packaged-build storage gate
  // and B's python product-integration gate.
  'e2e-m3c-storage-built.cjs',
  'e2e-m3c-python-integration.cjs',
];

// Resolve requested suite names against the registry. Returns the run list
// plus the unknown names; the CALLER decides to fail. Unknown names are
// never silently dropped — the old filter-to-empty behavior produced
// "all 0 browser gates passed" with exit 0.
function resolveSuites(requested, registry = SUITES) {
  const unknown = requested.filter((s) => !registry.includes(s));
  const suites = requested.length
    ? registry.filter((s) => requested.includes(s))
    : registry.slice();
  return { suites, unknown };
}

module.exports = { SUITES, resolveSuites };

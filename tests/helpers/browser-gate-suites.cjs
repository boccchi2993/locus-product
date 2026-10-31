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
  // Capability-install presentation e2e (C1-P3): the /mnt/download Import
  // entry, the summary dialog (untrusted content stays text), install and
  // the two-step uninstall over the REAL built app.
  'e2e-capability-ui.cjs',
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
  // C3 credentials UI + end-to-end (C3-P1b): Connect / Disconnect /
  // needs-reconfirmation, durable "Always allow" and the leak sweep, over
  // the REAL built app with the upstream intercepted at the relay.
  'e2e-credentials.cjs',
  // C4 §2.4 capability-import reports (self-contained, own build +
  // preview + Chrome): the REAL settings-panel import dialog writes one
  // report per attempt (broken package refusal, commit success, cancelled
  // confirm), the credential connect step writes none and no report ever
  // carries the test key, and a REAL task's bash cat reads a report back.
  'e2e-import-reports.cjs',
  // Composer "+" menu (Capabilities cascade, owner task 2026-10-29): the
  // real built app drives hover + keyboard cascade, imports from the
  // /mnt/download listing through the GLOBAL confirm dialog (settings
  // panel closed), checks the import-report cancellation, the @mention
  // insertion and the <640px stepped mode.
  'e2e-composer-menu.cjs',
  // Settings-panel mobile checks (owner UI review 2026-10-29, items
  // 9/10/11): under a 390×844 mobile+touch device simulation the settings
  // panel keeps its head × reachable at the bottom of the scroll, opening
  // Settings from the sidebar drawer closes the drawer and the FIRST touch
  // on × closes the panel, and the composer "+" / send buttons expose
  // ≥44×44 hit areas — every tap a real Input.dispatchTouchEvent.
  'e2e-settings-mobile.cjs',
  // Composer @-mentions (owner task 2026-10-29): the candidate popup
  // (trigger/filter/keyboard/insert/Enter-not-send), the mirror
  // highlight, the IME composition guard, send-time auto-enable with the
  // mention semantics inside the RECORDED system prompt, the error-state
  // block, the "+"-menu insert path and the timeline highlight (no
  // message-content innerHTML), over the real built app.
  'e2e-composer-mentions.cjs',
  // Markdown rendering + file delivery (owner task 2026-10-31): fenced
  // code block with Copy, ordered list, GFM table, protocol-allowlisted
  // links (javascript: stays literal), sandbox: file cards (existing /
  // missing) over the real VFS, the GLOBAL import confirm dialog over a
  // REAL fixture .locus (Cancel, nothing installed), the 本次生成的文件
  // row (sandbox dedupe) and no horizontal page scroll at 390×844.
  'e2e-render.cjs',
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

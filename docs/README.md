# Locus documentation

This directory is the wiki-style documentation home for Locus.

The repository keeps documentation beside code so architecture changes, tests, and prose can move in the same commit graph. A separate hosted wiki may mirror or link these pages later; **the repository documents are the source of truth**.

## Start here

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current layer model and system overview |
| [REPOSITORY-SPLIT.md](REPOSITORY-SPLIT.md) | Agreed Runtime / Harness / Product target, migration sequence and compatibility gates |
| [REPOSITORY-SPLIT-INVENTORY.md](REPOSITORY-SPLIT-INVENTORY.md) | M0 audit: per-symbol ownership, coupling catalog, extraction order at the pinned baseline |
| [REPOSITORY-SPLIT-CONTRACTS.md](REPOSITORY-SPLIT-CONTRACTS.md) | M0 interface drafts: lifecycle, ports, ownership answers, error and versioning semantics |
| [REPOSITORY-SPLIT-BASELINE.md](REPOSITORY-SPLIT-BASELINE.md) | M0 verification record: environment, commands, results, untested scope, findings |
| [REPOSITORY-SPLIT-M1A-VERIFICATION.md](REPOSITORY-SPLIT-M1A-VERIFICATION.md) | M1a verification record: extracted modules, lifecycle test evidence, gate results |
| [REPOSITORY-SPLIT-M2A-DESIGN.md](REPOSITORY-SPLIT-M2A-DESIGN.md) | M2a design record: Runtime entry, packaging, authorization port (symbol-level, deviations recorded) |
| [REPOSITORY-SPLIT-M2B-DESIGN.md](REPOSITORY-SPLIT-M2B-DESIGN.md) | M2b design record: Harness entry, ToolPort snapshots, model client factory |
| [REPOSITORY-SPLIT-M2C-DESIGN.md](REPOSITORY-SPLIT-M2C-DESIGN.md) | M2c design record: public capability declarations, the Product compatibility check, the shared tool adapter, joint suites |
| [REPOSITORY-SPLIT-M2C-VERIFICATION.md](REPOSITORY-SPLIT-M2C-VERIFICATION.md) | M2c verification record: I1–I7 joint evidence, browser joint gate, first failures, unverified scope |
| [DESIGN-PRINCIPLES.md](DESIGN-PRINCIPLES.md) | Rules used to decide where functionality belongs |
| [CONCEPTS.md](CONCEPTS.md) | Canonical vocabulary and terms |
| [RUNTIME-MODEL.md](RUNTIME-MODEL.md) | One task from user input to local execution/provider replay |
| [SECURITY-MODEL.md](SECURITY-MODEL.md) | Authority, approval, trust zones, and explicit non-claims |
| [EXTENSION-MODEL.md](EXTENSION-MODEL.md) | Capability / Plugin / Skill / MCP contracts |
| [CAPABILITY-PACKAGE.md](CAPABILITY-PACKAGE.md) | Capability project, bundle, validation, and import contract |
| [CAPABILITY-AUTHORING.md](CAPABILITY-AUTHORING.md) | End-to-end authoring, Reference Capability, and self-hosting acceptance |
| [TESTING.md](TESTING.md) | Test philosophy, gates, and adversarial proof |
| [M4A-A-CORE-CANDIDATE.md](M4A-A-CORE-CANDIDATE.md) | Core-main candidate lane: capture/apply/verify tool, workflow contract, rehearsal record |
| [M4A-B-OWNERSHIP-CLEANUP.md](M4A-B-OWNERSHIP-CLEANUP.md) | M4a-B audit: stale entries removed, kept-with-reason list, ownership gate |
| [M4A-C-MAINLINE-ROLLOUT.md](M4A-C-MAINLINE-ROLLOUT.md) | Mainline rollout plan + read-only preflight tool for landing the three-repo switch |
| [M4A-INTEGRATION.md](M4A-INTEGRATION.md) | M4a-D integration record: input SHAs, conflicts, verified combos, mainline landing checklist |
| [CAPABILITY-BOUNDARIES.md](CAPABILITY-BOUNDARIES.md) | Detailed core-vs-extension admission rules |
| [LINUX-LIKE-VFS.md](LINUX-LIKE-VFS.md) | Filesystem namespace and mount authority |
| [NETWORK-RUNTIME.md](NETWORK-RUNTIME.md) | HTTP routing, retry, and approval semantics |
| [APPROVALS.md](APPROVALS.md) | Suspend/resume approval framework |
| [MODEL-PROTOCOL.md](MODEL-PROTOCOL.md) | Provider-native history and replay |
| [PERSISTENCE.md](PERSISTENCE.md) | IndexedDB/OPFS and recovery semantics |
| [IMAGE-INPUT.md](IMAGE-INPUT.md) | Image/perception boundary |

The three-repository split is IMPLEMENTED: this repository consumes
`locus-runtime` and `locus-harness` as pinned GitHub dependencies through
`src/product/runtime-api.js` and `src/product/harness-api.js` — ONE ESM
page entry, no in-repo core duplicates (the M3c switch; verified in
[M3C-D-INTEGRATION.md](M3C-D-INTEGRATION.md) and
[M3C-REVIEW-VERIFICATION.md](M3C-REVIEW-VERIFICATION.md), with the fixed
dependency SHAs recorded in the repository README). The migration M0
audit and contract round, M1 (task assembly + interpreter lifecycle), M2a
(Runtime independentization), M2b (Harness independentization) and M2c
(public capability declarations + the Product compatibility gate + joint
integration gates) records above remain the migration history. The stale
planning snapshots `ROADMAP.md` / `TODO.md` (monorepo-era status that
contradicted the completed split) were removed in the M4a-B ownership
cleanup — see [M4A-B-OWNERSHIP-CLEANUP.md](M4A-B-OWNERSHIP-CLEANUP.md).

### Two dependency lanes — do not conflate them

1. **The verified fixed combo.** Every green gate run so far (M3c
   acceptance and M4a-D integration) tested ONE pinned combination:
   Product at its integration head consuming `locus-runtime`
   `2435a57ff7a66db3db88aa98a88d404c75133483` and `locus-harness`
   `347eed99a415dc080b97d46d8a4271ceb19c5142` (pins live in the
   repository README and `package.json`). A green gate on this lane says
   nothing about any other core SHA.
2. **The core-main candidate lane.** The scheduled/manual pipeline
   ([M4A-A-CORE-CANDIDATE.md](M4A-A-CORE-CANDIDATE.md)) captures the two
   cores' *current* `main` SHAs into a snapshot and verifies Product
   against exactly that combination in a throwaway checkout. It never
   rewrites the verified pins, never auto-PRs. Until the extraction
   implementation lands on both cores' `main`, candidate capture
   honestly fails at install (both mains lack the implementation —
   recorded in the M4a-D integration doc).

A pass in one lane must never be reported as a pass in the other: the
fixed combo is *verified history*, the candidate lane is *ongoing
verification of latest main*. Until the candidate workflow reaches the
default branch (schedule/dispatch are default-branch gated), it has not
run automatically anywhere.

## What is normative?

1. **Code + tests** — evidence of what current `main` actually does.
2. **Architecture / security / concept docs** — intended invariants; implementation changes should update them deliberately.
3. **Branch / verification records** (repository `README`, `M3C-*.md`, `M4A-*.md`) — status and future work, not permission to claim a future feature exists.
4. **Candidate studies** — `docs/plugins/` explores possibilities; none is selected merely because a requirements document exists.
5. **Audit snapshots** — `Locus-audit-*.md` describes a historical commit and may intentionally contain facts later fixed.

When two current normative documents disagree, treat it as a documentation bug.

## Current architecture in one screen

```
User
  |
Capability
  |---- Plugin        local code, no authority in v1
  |---- SkillInstance capability-private mutable guidance
  |---- MCP           external authority requirement
  |
TaskEnvironment (frozen identity snapshot)
  |
AgentSession / Harness
  |
  +---- Provider protocol / model input
  |       +---- Perception / image gate
  |
  +---- bash
          +---- VFS -------- Filesystem
          +---- Python ----- Execution
          +---- curl ------- Network

Current model tools: bash + cloud_bash (stub)
```

Production extension catalogs are currently empty. Trusted Plugin Runtime v1 is the next extension-layer infrastructure milestone.

## Maintenance rule

New implementation work should answer:

- Which invariant does this rely on or change?
- Which document owns that invariant?
- Which test proves the new statement?

If the answer is “none”, the change probably needs a contract before it needs more code.
# locus-product

Locus Product — the application repository of the three-repository Locus
split: Vue 3 presentation, browser storage, user configuration, capability
catalogs, and the integration adapters that compose `locus-runtime` and
`locus-harness` into the shipped product.

**Status: baseline only (M3c-0).** This repository holds the imported source
snapshot of the product code as the common baseline for the parallel M3c
switch agents. The import switch itself is intentionally NOT implemented
here yet; see `docs/M3C-PARALLEL-HANDOFF.md` on `refactor/m3c-base`.

## Provenance

Extracted from
[boccchi2993/Locus-browser-agent-runtime](https://github.com/boccchi2993/Locus-browser-agent-runtime)
@ `2aec76e78431382873be1db8a6db6310cc89c782` (branch
`refactor/repository-split-m2c`, head of OPEN PR #7). Until the product's
imports switch (M3c), that repository remains the authoritative
implementation.

Sibling repositories consumed by this one:

- [boccchi2993/locus-runtime](https://github.com/boccchi2993/locus-runtime)
  @ `2435a57ff7a66db3db88aa98a88d404c75133483` (PR #1)
- [boccchi2993/locus-harness](https://github.com/boccchi2993/locus-harness)
  @ `347eed99a415dc080b97d46d8a4271ceb19c5142` (PR #1)

License: Apache-2.0 (see [LICENSE](LICENSE)).

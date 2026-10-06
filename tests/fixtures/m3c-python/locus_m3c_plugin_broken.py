"""M3c review B fixture plugin — the BROKEN payload.

Same module name and payload shape as the good fixture, but the module
does not compile. The smoke import (install-before-READY) must fail the
boot honestly: no READY, no silent fallback to any other execution path,
zero network requests. This file is deliberately invalid Python.
"""
ANSWER = 42


def answer(:
    return ANSWER

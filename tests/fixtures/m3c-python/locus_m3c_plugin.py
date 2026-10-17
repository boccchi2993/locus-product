"""M3c review B fixture plugin — the GOOD wheel payload.

Shipped inside a REAL .locus capability package and installed through the
REAL import service (D10 §6), so the task's prepare() installs the wheel
offline BEFORE READY and the smoke import proves the module really landed
in THIS build's interpreter.
"""
ANSWER = 42


def answer():
    return ANSWER

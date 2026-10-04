"""M3c review B fixture plugin — the GOOD payload.

Served to the interpreter through the Product composition's documented
plugin-runtime provider seam (registerPluginRuntimeProvider('python', ...)),
so the task's prepare() installs it BEFORE READY and the smoke import
proves the module really landed in THIS build's interpreter.
"""
ANSWER = 42


def answer():
    return ANSWER

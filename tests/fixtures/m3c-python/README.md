# m3c-python wheel fixtures (TEST ONLY)

Two REAL pure-Python wheels used by the wheel-only plugin e2e
(`tests/e2e-m3c-python-integration.cjs`) and the worker-install unit block
(`tests/capability-composition.test.cjs`). Not production artifacts.

- `locus_m3c_plugin-1.0.0-py3-none-any.whl` — packs the good sibling module
  (`locus_m3c_plugin.py`); imports cleanly and `answer() == 42`.
- `locus_m3c_plugin_broken-1.0.0-py3-none-any.whl` — packs the deliberately
  invalid sibling module (`locus_m3c_plugin_broken.py`); the runtime's
  smoke import must fail the boot closed.

## Regeneration

```
python tests/fixtures/m3c-python/build_wheels.py
```

Python stdlib only (zipfile / hashlib / base64). Byte-identical across
runs: fixed 1980-01-01 timestamps, name-sorted members, fixed external
attrs. After regenerating, update the sha256 list below.

## sha256

```
c15c1fb0839519c84ce92e968e8bb1cd120eae0cbb7b21b6fcbdaacd4a17e8f6  locus_m3c_plugin-1.0.0-py3-none-any.whl
1d5a2147d5ba3198e9d0173b8d8c2af85a732ee144bc2a585744b0cb0abb8257  locus_m3c_plugin_broken-1.0.0-py3-none-any.whl
```

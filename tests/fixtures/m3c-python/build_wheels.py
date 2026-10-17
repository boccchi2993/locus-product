#!/usr/bin/env python3
"""Deterministically regenerate the m3c-python wheel fixtures (D10 §6).

TEST ONLY. Packs the two sibling module files into REAL pure-Python wheels
(correct zip layout, dist-info METADATA / WHEEL / RECORD with hash+size
rows, fixed 1980 timestamps, name-sorted members, fixed external attrs):

    locus_m3c_plugin.py        -> locus_m3c_plugin-1.0.0-py3-none-any.whl
    locus_m3c_plugin_broken.py -> locus_m3c_plugin_broken-1.0.0-py3-none-any.whl

The good wheel smoke-imports and answers 42; the broken wheel contains
deliberately invalid Python so the runtime's smoke import fails the boot
closed. The wheel-only plugin migration (docs/DECISIONS.md D10 §6) installs
these bytes through the real .locus import service, so the e2e exercises
the REAL Pyodide offline install path.

Stdlib only (zipfile / hashlib / base64): no pip, no build backend, no
network. Byte-identical across runs (fixed date_time, sorted member order,
fixed external attrs). After regenerating, update the sha256 list in the
sibling README.md.
"""
import base64
import hashlib
import zipfile
from datetime import datetime
from pathlib import Path

VERSION = "1.0.0"
FIXED_DATE = (1980, 1, 1, 0, 0, 0)
HERE = Path(__file__).resolve().parent

# module filename -> (dist Name as pip normalizes it, generator tag)
MODULES = [
    ("locus_m3c_plugin.py", "locus-m3c-plugin", "locus-test"),
    ("locus_m3c_plugin_broken.py", "locus-m3c-plugin-broken", "locus-test"),
]


def record_digest(data: bytes) -> str:
    sha = base64.urlsafe_b64encode(hashlib.sha256(data).digest())
    return "sha256=" + sha.rstrip(b"=").decode("ascii")


def build_wheel(module_filename: str, dist_name: str, generator: str) -> bytes:
    module = module_filename[: -len(".py")]
    dist = f"{module}-{VERSION}.dist-info"

    metadata = (
        "Metadata-Version: 2.1\n"
        f"Name: {dist_name}\n"
        f"Version: {VERSION}\n"
        "Summary: Locus m3c-python wheel fixture (TEST ONLY)\n"
        "\n"
        f"# {module}\n"
        "\n"
        "TEST ONLY fixture wheel for the Locus wheel-only plugin e2e.\n"
    ).encode("utf-8")
    wheel = (
        "Wheel-Version: 1.0\n"
        f"Generator: {generator}\n"
        "Root-Is-Purelib: true\n"
        "Tag: py3-none-any\n"
    ).encode("utf-8")
    module_data = (HERE / module_filename).read_bytes()

    members = [
        (module_filename, module_data),
        (f"{dist}/METADATA", metadata),
        (f"{dist}/WHEEL", wheel),
    ]
    record_rows = [f"{name},{record_digest(data)},{len(data)}" for name, data in members]
    record_rows.append(f"{dist}/RECORD,,")
    record = ("\n".join(record_rows) + "\n").encode("utf-8")

    out = HERE / f"{module}-{VERSION}-py3-none-any.whl"
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in sorted(members + [(f"{dist}/RECORD", record)]):
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3  # unix, pinned for determinism
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)
    return out


def main() -> None:
    for module_filename, dist_name, generator in MODULES:
        out = build_wheel(module_filename, dist_name, generator)
        sha = hashlib.sha256(out.read_bytes()).hexdigest()
        print(f"wrote {out.name} ({out.stat().st_size} bytes) sha256={sha}")


if __name__ == "__main__":
    main()

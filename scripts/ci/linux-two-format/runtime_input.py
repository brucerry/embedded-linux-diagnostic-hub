"""Admit the exact source-rebuilt Linux x64 AppImage prefix."""

import json
import os
from pathlib import Path
import stat

import tar_admission as pins

INPUT = "corrected-appimage-runtime-x64"
RUNTIME = "runtimes/runtime-x64"
RUNTIME_BYTES = 961096
RUNTIME_SHA = "1d202e65e0f1b7013e7f6941b3f4785ecac9f9a5868196fabbfdef33d997ce33"
SPEC_SHA = "1ad13c679a8cad343d7a78537ebdc933d6e139451e2d222e97e3250f6dc1bde7"
SOURCE = Path(__file__).resolve().parent / "runtime-source"


def read_spec():
    _, digest, body = pins.file_data(SOURCE / "RUNTIME.json", "corrected-runtime-spec", capture=True)
    pins.need(digest["sha256"] == SPEC_SHA, "corrected-runtime-spec-pin")
    spec = json.loads(body)
    pins.need(os.uname().sysname == "Linux" and os.uname().machine == spec["architecture"] == "x86_64"
              and spec["toolset"] == "1.0.3"
              and spec["output"] == {"bytes": RUNTIME_BYTES, "sha256": RUNTIME_SHA},
              "corrected-runtime-x64-scope")
    return spec


def read_runtime(path):
    info, digest, body = pins.file_data(
        path, "corrected-runtime-input", byte_count=RUNTIME_BYTES, capture=True,
    )
    pins.need(digest["sha256"] == RUNTIME_SHA and body[:6] == b"\x7fELF\x02\x01"
              and body[8:11] == b"AI\x02" and body[16:20] == b"\x03\x00\x3e\x00"
              and stat.S_IMODE(info.st_mode) in (0o400, 0o644),
              "corrected-runtime-pin")
    return body


def read_notices(spec):
    root = SOURCE / "notices"
    pins.need({path.name for path in root.iterdir()} == set(spec["notices"]),
              "corrected-runtime-notice-roster")
    result = {}
    for name, entry in spec["notices"].items():
        _, digest, body = pins.file_data(root / name, "corrected-runtime-notice",
                                         byte_count=entry["bytes"], capture=True, capture_limit=65536)
        pins.need(digest["sha256"] == entry["sha256"], "corrected-runtime-notice-pin")
        result[name] = body
    return result


def stage_notices(root, notices):
    # Builder copies lib/x64 into the AppImage stage only. The shared AppDir
    # and the tar archive do not receive these runtime-specific notices.
    target = root / "lib/x64/appimage-runtime-notices"
    target.mkdir(mode=0o700)
    for name, body in notices.items():
        with (target / name).open("xb") as output:
            output.write(body)

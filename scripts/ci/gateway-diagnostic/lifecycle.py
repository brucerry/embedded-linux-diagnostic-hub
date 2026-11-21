"""Pure status and confined-stage guards shared by the held adapters."""
from contextlib import contextmanager
import os


def report(phase, result):
    if result not in ("pass", "fail"):
        raise ValueError("runtime-status")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(phase + "=" + result + "\n")


@contextmanager
def reached(phase):
    try:
        yield
    except Exception:
        report(phase, "fail")
        raise
    report(phase, "pass")


def exact_gateway_mounts(mounts, stage):
    if not isinstance(mounts, list):
        raise ValueError("input-mount-census")
    seen = set()
    for mount in mounts:
        kind, dest = mount.get("Type"), mount.get("Destination")
        if dest in seen:
            raise ValueError("duplicate-mount")
        if (kind, dest) == ("bind", "/staged"):
            if mount.get("Source") != str(stage) or mount.get("RW") is not False:
                raise ValueError("input-mount")
        elif (kind, dest) == ("tmpfs", "/scratch"):
            if mount.get("RW") is not True:
                raise ValueError("scratch-mount")
        else:
            raise ValueError("unexpected-mount")
        seen.add(dest)
    if "/staged" not in seen:
        raise ValueError("missing-input-mount")

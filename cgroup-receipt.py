"""Review-only classifier of bounded, caller-owned transient-unit observations.

Does not create units, read the OS, authenticate observations or admit release.
"""
import re

COMPONENT = re.compile(r"[A-Za-z0-9_.@:-]{1,180}")
UNIT = re.compile(r"hub-v060-probe-[a-f0-9]{24}\.service")


def cgroup_path(line, unit):
    if not UNIT.fullmatch(unit):
        raise ValueError("expected unique fixed-prefix probe unit")
    if type(line) is not str or len(line) > 8192 or not line.startswith("0::/"):
        raise ValueError("not one unified membership record")
    path = line[3:]
    parts = path.split("/")[1:]
    if not parts or parts[-1] != unit or any(
        not COMPONENT.fullmatch(p) or p in (".", "..") for p in parts
    ):
        raise ValueError("membership is not the owned test unit")
    return path


def populated(events):
    if type(events) is not str or len(events) > 1024:
        raise ValueError("invalid cgroup.events size")
    seen = {}
    for line in events.splitlines():
        match = re.fullmatch(r"([a-z_]+) ([0-9]+)", line)
        if not match or match[1] in seen:
            raise ValueError("invalid cgroup.events record")
        seen[match[1]] = match[2]
    if seen.get("populated") not in ("0", "1"):
        raise ValueError("missing or invalid populated entry")
    return seen["populated"] == "1"


def classify(unit, direct, child, active, retired, owned_exit, closed_pipes):
    if cgroup_path(direct, unit) != cgroup_path(child, unit):
        raise ValueError("child membership differs")
    if not populated(active):
        raise ValueError("owned cgroup was not observed populated")
    status = "retirement_unknown"
    if retired is not None and not populated(retired) and owned_exit is True and closed_pipes is True:
        status = "benign_process_and_group_retired"
    return {"mode": "preflight_model", "status": status, "release_admitted": False}

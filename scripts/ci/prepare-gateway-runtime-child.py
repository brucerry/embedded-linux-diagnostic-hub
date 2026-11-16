"""Strict one-request child bridge. No action on import; main is injectable for tests.

This prepares the five frozen runtime dependencies only. It never starts Gateway,
SSH, package scripts or another child. The owned JS caller must authenticate this
script and siblings before launch, then reread every emitted archive/census itself.
"""

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


REQUEST_LIMIT = 1024 * 1024
MANIFEST_LIMIT = 8192
ERROR_LIMIT = 1024
RETAINED = []
NAMES = ("asn1", "bcrypt-pbkdf", "safer-buffer", "ssh2", "tweetnacl")
FIELDS = {"schemaVersion", "sourceLockBase64", "profileBase64", "installRoot", "archivesRoot", "checkoutRoot", "uid"}


class ChildRefused(ValueError):
    pass


def require(condition):
    if not condition:
        raise ChildRefused("Invalid runtime-input child request")


def load_sibling(filename, name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_request(raw):
    require(type(raw) is bytes and 0 < len(raw) <= REQUEST_LIMIT)

    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value)
            value[key] = item
        return value

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                       parse_constant=lambda _: require(False))
    require(type(value) is dict and set(value) == FIELDS and
            type(value["schemaVersion"]) is int and value["schemaVersion"] == 1 and
            type(value["uid"]) is int and value["uid"] > 0)
    decoded = []
    for key, maximum in (("sourceLockBase64", 4 * 1024**2), ("profileBase64", 16384)):
        text = value[key]
        require(type(text) is str and text.isascii() and len(text) <= 4 * ((maximum + 2) // 3))
        body = base64.b64decode(text, validate=True)
        require(0 < len(body) <= maximum and base64.b64encode(body).decode("ascii") == text)
        decoded.append(body)
    for key in ("installRoot", "archivesRoot", "checkoutRoot"):
        require(type(value[key]) is str and len(value[key]) <= 4096)
    return value, decoded[0], decoded[1]


def manifest_for(state, packages, source, profile):
    require(type(state) is dict and state.get("status") == "prepared-inputs-not-runtime" and
            state.get("phase") == "complete" and not state.get("pending") and
            not state.get("unknownReturns") and state.get("runtimeExecuted") is False)
    rows = state.get("archives")
    require(type(rows) is list and len(rows) == 5 and
            [row.get("path") for row in rows] == ["node_modules/" + name for name in NAMES])
    result = []
    for index, (row, package) in enumerate(zip(rows, packages), 1):
        require(type(row) is dict and set(row) == {"path", "bytes"} and
                type(row["bytes"]) is bytes and 18 <= len(row["bytes"]) <= 16 * 1024**2)
        sri = package["integrity"]
        require(type(sri) is str and re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", sri) and
                hashlib.sha512(row["bytes"]).digest() == base64.b64decode(sri[7:], validate=True))
        result.append({"path": row["path"], "file": str(index) + ".tgz", "bytes": len(row["bytes"]),
                       "sha256": hashlib.sha256(row["bytes"]).hexdigest()})
    return {"schemaVersion": 1, "status": "prepared-inputs-not-runtime",
            "sourceLockSHA256": hashlib.sha256(source).hexdigest(),
            "profileSHA256": hashlib.sha256(profile).hexdigest(), "archives": result}


def write_once(stream, data):
    require(type(data) is bytes)
    count = stream.write(data)
    require(type(count) is int and count == len(data))
    require(stream.flush() is None)


def main(stdin=None, stdout=None, stderr=None, *, module=None, native_factory=None,
         uid_provider=os.getuid, environment=None):
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout.buffer if stdout is None else stdout
    stderr = sys.stderr.buffer if stderr is None else stderr
    stage, native, state = "request", None, None
    try:
        raw = stdin.read(REQUEST_LIMIT + 1)
        request, source, profile = parse_request(raw)
        actual_uid = uid_provider()
        require(type(actual_uid) is int and actual_uid == request["uid"] and actual_uid > 0)
        module = load_sibling("prepare-gateway-runtime-inputs.py", "gateway_runtime_inputs") if module is None else module
        # Frozen bytes/profile and lexical paths are checked BEFORE any native port factory.
        packages = module.validate_runtime_inputs(source, profile)
        for key in ("installRoot", "archivesRoot", "checkoutRoot"):
            module.absolute(request[key])
        require(request["checkoutRoot"] != "/" and
                request["installRoot"].endswith("/validation/gateway-runtime/install") and
                request["archivesRoot"] == str(Path(request["installRoot"]).parent) + "/inputs/runtime-archives" and
                not (request["installRoot"] == request["checkoutRoot"] or
                     request["installRoot"].startswith(request["checkoutRoot"] + "/")))
        stage = "native"
        if native_factory is None:
            native_module = load_sibling("gateway-runtime-native.py", "gateway_runtime_native")
            native_factory = native_module.NativeRuntimePorts
        native = native_factory(request["uid"], request["installRoot"], request["archivesRoot"],
                                request["checkoutRoot"], packages, environment=environment)
        stage = "preparation"
        state = module.prepare_runtime_inputs(source, profile, request["installRoot"], request["archivesRoot"],
                                              request["checkoutRoot"], request["uid"], native.ports())
        manifest = manifest_for(state, packages, source, profile)
        payload = (json.dumps(manifest, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        require(len(payload) <= MANIFEST_LIMIT)
        stage = "output"
        write_once(stdout, payload)
        return 0
    except BaseException as error:
        RETAINED.append({"stage": stage, "error": error, "native": native,
                         "preparation": state, "custody": getattr(error, "custody", None)})
        # No raw errors, filesystem paths, payloads, environment or credential data leave stdout/stderr.
        reason = {"request": "invalid-input", "native": "native-port-refused",
                  "preparation": "preparation-refused", "output": "output-failed"}[stage]
        diagnostic = (json.dumps({"schemaVersion": 1, "status": "refused", "stage": stage,
                                 "reason": reason}, separators=(",", ":")) + "\n").encode("ascii")
        if len(diagnostic) <= ERROR_LIMIT:
            try:
                write_once(stderr, diagnostic)
            except BaseException as reporting_error:
                RETAINED[-1]["reportingError"] = reporting_error
        # A failed/partial stdout write cannot be retracted. Exit1 and strict caller parsing
        # must refuse it; this function never retries the write or claims an empty pipe then.
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

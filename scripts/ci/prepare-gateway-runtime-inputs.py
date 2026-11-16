"""Inert Gateway runtime-input draft; all host effects require explicit owned ports.

There is deliberately no native downloader, filesystem adapter or command entrypoint.
This does not install or run Gateway merely by importing it. Callers must bind the
canonical same-job package/record independently and census every installed byte.
"""

import base64
import hashlib
import inspect
import json
import math
from pathlib import PurePosixPath
import re
import unicodedata
import zlib


SOURCE_LOCK_SHA256 = "19b9794c0da10a71bb3ecdb4cc03019706e3f4c45a070bc3fcdf07b9a53c2ec3"
NAMES = ("asn1", "bcrypt-pbkdf", "safer-buffer", "ssh2", "tweetnacl")
PINNED = (
    ("0.2.6", "sha512-ix/FxPn0MDjeyJ7i/yoHGFt/EX6LyNbxSEhPPXODPL+KB0VPk86UYfL0lMdy+KCnv+fmvIzySwaK5COwqVbWTQ=="),
    ("1.0.2", "sha512-qeFIXtP4MSoi6NLqO12WfqARWWuCKi2Rn/9hJLEmtB5yTNr9DqFWkJRCf2qShWzPeAMRnOgCrq0sg/KLv5ES9w=="),
    ("2.1.2", "sha512-YZo3K82SD7Riyi0E1EQPojLz7kpepnSQI9IyPbHHg1XXXevb5dJI7tpyN2ADxGcQbHG7vcyRHk0cbwqcQriUtg=="),
    ("1.17.0", "sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ=="),
    ("0.14.5", "sha512-KXXFFdAbFXY4geFIwoyNK+f5Z1b7swfXABfL7HXCmoIWMKU3dmS26672A4EeQtDzLKy7SXmfBu51JolvEKwtGA=="),
)
LIMITS = {"compressed": 16 * 1024**2, "expanded": 64 * 1024**2,
          "expandedTotal": 256 * 1024**2, "entriesTotal": 4096,
          "member": 32 * 1024**2, "secondsPerInput": 45, "chunksPerInput": 4096}


class RuntimeInputRefused(ValueError):
    def __init__(self, reason, custody=None):
        self.reason = reason
        self.custody = custody
        super().__init__("Gateway runtime-input preparation refused: " + reason)


def require(condition, reason):
    if not condition:
        raise RuntimeInputRefused(reason)


def json_bytes(raw, maximum):
    require(type(raw) is bytes and 0 < len(raw) <= maximum, "json-bounds")

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "json-duplicate")
            result[key] = value
        return result

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: require(False, "json-number"))
    except RuntimeInputRefused:
        raise
    except (ValueError, UnicodeError):
        raise RuntimeInputRefused("json-invalid") from None


def expected_profile():
    return {"schemaVersion": 1, "sourceLockSHA256": SOURCE_LOCK_SHA256,
            "packages": [{"name": name, "version": version,
                          "url": "https://registry.npmjs.org/" + name + "/-/" + name + "-" + version + ".tgz",
                          "integrity": integrity}
                         for name, (version, integrity) in zip(NAMES, PINNED)]}


def validate_runtime_inputs(source_lock_bytes, profile_bytes):
    """Freeze exactly the existing required closure; no dependency solver or caller pin."""
    require(type(source_lock_bytes) is bytes and len(source_lock_bytes) <= 4 * 1024**2,
            "source-lock-bounds")
    require(hashlib.sha256(source_lock_bytes).hexdigest() == SOURCE_LOCK_SHA256,
            "source-lock-integrity")
    profile = json_bytes(profile_bytes, 16384)
    require(type(profile) is dict and type(profile.get("schemaVersion")) is int and
            profile == expected_profile(), "input-profile")
    lock = json_bytes(source_lock_bytes, 4 * 1024**2)
    require(lock.get("lockfileVersion") == 3 and lock.get("version") == "0.6.0", "source-lock")
    packages = lock["packages"]
    closure, pending = set(), ["ssh2"]
    while pending:
        name = pending.pop()
        if name in closure:
            continue
        require(name in NAMES, "runtime-closure")
        closure.add(name)
        entry = packages["node_modules/" + name]
        require(not entry.get("link") and not entry.get("peerDependencies"), "runtime-closure")
        pending.extend(entry.get("dependencies", {}))
    require(closure == set(NAMES), "runtime-closure")
    result = []
    for pin in profile["packages"]:
        entry = packages["node_modules/" + pin["name"]]
        require(all(entry.get(k) == pin[p] for k, p in
                    (("version", "version"), ("resolved", "url"), ("integrity", "integrity"))),
                "runtime-pin")
        result.append({**pin, "dependencies": entry.get("dependencies", {}),
                       "optionalDependencies": entry.get("optionalDependencies", {})})
    return result


def text(raw):
    end = raw.find(b"\0")
    if end >= 0:
        require(not any(raw[end:]), "tar-padding")
        raw = raw[:end]
    try:
        return raw.decode("utf-8")
    except UnicodeError:
        raise RuntimeInputRefused("tar-text") from None


def octal(raw, blank=False):
    if blank and re.fullmatch(b"[ \0]*", raw):
        return 0
    require(re.fullmatch(b" *[0-7]+[ \0]*", raw) is not None, "tar-number")
    return int(raw.rstrip(b" \0").lstrip(), 8)


def canonical(value):
    require(type(value) is str and 0 < len(value.encode("utf-8")) <= 1024 and
            value == unicodedata.normalize("NFC", value) and
            not re.search(r"[\\:\x00-\x1f\x7f]", value), "member-path")
    parts = value.split("/")
    require(all(p not in ("", ".", "..") and not p.endswith((" ", ".")) for p in parts),
            "member-path")
    return parts


def inspect_runtime_archive(raw, package):
    """Verify compressed SRI BEFORE bounded decoding. Return inert complete file bytes.

    This low-level parser accepts fixture identities for isolated tests. Actual preparation
    obtains every identity exclusively from validate_runtime_inputs, never caller archives.
    """
    require(type(raw) is bytes and 18 <= len(raw) <= LIMITS["compressed"], "archive-size")
    sri = package["integrity"]
    require(type(sri) is str and re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", sri), "archive-sri")
    wanted = base64.b64decode(sri[7:], validate=True)
    require(base64.b64encode(wanted).decode() == sri[7:] and
            hashlib.sha512(raw).digest() == wanted, "archive-integrity")
    require(raw[:4] == b"\x1f\x8b\x08\0", "gzip-header")
    expanded = int.from_bytes(raw[-4:], "little")
    require(1024 <= expanded <= LIMITS["expanded"] and expanded % 512 == 0, "gzip-size")
    decoder = zlib.decompressobj(31)
    try:
        tar = decoder.decompress(raw, expanded + 1)
    except zlib.error:
        raise RuntimeInputRefused("gzip-invalid") from None
    require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail and
            len(tar) == expanded, "gzip-trailing-or-size")
    files, directories, seen, ancestors = {}, set(), {}, set()
    offset, count, root, global_comment = 0, 0, None, False
    while offset + 512 <= len(tar) and any(tar[offset:offset + 512]):
        count += 1
        require(count <= LIMITS["entriesTotal"], "member-count")
        head = tar[offset:offset + 512]
        require(octal(head[148:156]) == sum(head[:148]) + 8 * 32 + sum(head[156:]), "tar-checksum")
        require(head[257:265] == b"ustar\00000" and not any(head[500:]), "tar-format")
        require(not any(head[157:257]), "member-link")
        kind = head[156]
        prefix = text(head[345:500])
        name = (prefix + "/" if prefix else "") + text(head[:100])
        directory = kind == 53
        if directory and name.endswith("/"):
            name = name[:-1]
        parts = canonical(name)
        mode, length = octal(head[100:108]), octal(head[124:136])
        for begin, end in ((108, 116), (116, 124), (136, 148)):
            octal(head[begin:end], True)
        text(head[265:297]); text(head[297:329])
        require(octal(head[329:337], True) == octal(head[337:345], True) == 0, "member-device")
        start, finish = offset + 512, offset + 512 + length
        following = start + ((length + 511) // 512) * 512
        require(length <= LIMITS["member"] and following <= len(tar) and
                not any(tar[finish:following]), "member-size-or-padding")
        if kind == 103:
            # Retain the existing inert GitHub PAX-comment grammar; never apply PAX state.
            require(offset == 0 and not global_comment and root is None and
                    name == "pax_global_header" and not prefix and mode == 0o666 and
                    length == 52 and re.fullmatch(b"52 comment=[a-f0-9]{40}\n", tar[start:finish]),
                    "pax-policy")
            global_comment = True
            offset = following
            continue
        require(kind in (0, 48, 53), "member-type")
        root = root or parts[0]
        require(parts[0] == root and (len(parts) > 1 or directory), "member-root")
        # Metadata bits are inert; normalized private modes below never copy archive modes.
        require(mode <= 0o777 and not mode & 0o002 and mode & 0o400 and
                (not directory or (mode & 0o100 and length == 0)), "member-mode")
        key = name.lower()
        require(key not in seen and (directory or key not in ancestors), "member-alias")
        parent = key
        while "/" in parent:
            parent = parent.rsplit("/", 1)[0]
            require(seen.get(parent) != "file", "member-parent-alias")
            ancestors.add(parent)
        seen[key] = "directory" if directory else "file"
        if len(parts) > 1:
            relative = "/".join(parts[1:])
            require("node_modules" not in [p.lower() for p in parts[1:]] and
                    not relative.lower().endswith(".node"), "native-or-bundled")
            if directory:
                directories.add(relative)
            else:
                files[relative] = tar[start:finish]
        offset = following
    require(1024 <= len(tar) - offset <= 10240 and not any(tar[offset:]), "tar-trailing")
    manifest = json_bytes(files.get("package.json"), 1024**2)
    require(type(manifest) is dict and manifest.get("name") == package["name"] and
            manifest.get("version") == package["version"], "package-identity")
    require(manifest.get("dependencies", {}) == package.get("dependencies", {}) and
            manifest.get("optionalDependencies", {}) == package.get("optionalDependencies", {}) and
            not manifest.get("peerDependencies") and not manifest.get("bundledDependencies") and
            not manifest.get("bundleDependencies") and not manifest.get("bin"), "package-closure")
    return {"files": files, "directories": directories, "expandedBytes": expanded,
            "members": count, "archiveSHA256": hashlib.sha256(raw).hexdigest()}


def absolute(value):
    require(type(value) is str and value.startswith("/") and str(PurePosixPath(value)) == value and
            not re.search(r"[\\\x00-\x20\x7f]", value) and ".." not in value.split("/"), "directory-path")


def prepare_runtime_inputs(source_lock_bytes, profile_bytes, install_root, archives_root,
                           checkout_root, uid, ports):
    """Synchronous explicit ports only; no native defaults, deletion, retry or scripts.

    Ports: now(); fetch(request)->{status,url,length,read(maximum),close()};
    lstat_directory(path)->{path,realpath,uid,mode,ino,dev,directory};
    mkdir_exclusive(path,0700)->None; write_exclusive(path,bytes,0600)->None.
    The future native adapter must enforce nofollow, exclusive creation, stable
    owned parent custody, no proxies/custom trust, no redirects/retries and the
    documented request bound. These injected ports are not authentication.
    """
    state = {"phase": "admission", "status": "pending", "archives": [], "responses": [], "created": [],
             "pending": [], "unknownReturns": [], "directoryIdentities": {},
             "completedFiles": 0, "runtimeExecuted": False}

    def call(role, fn, *args, acknowledgment=False):
        operation = {"role": role}
        state["pending"].append(operation)
        value = fn(*args)
        if inspect.isawaitable(value):
            state["unknownReturns"].append(value)
            raise RuntimeInputRefused("unsupported-port-return")
        if acknowledgment and value is not None:
            state["unknownReturns"].append(value)
            raise RuntimeInputRefused("unsupported-port-return")
        state["pending"].remove(operation)
        return value

    def now():
        value = call("clock", ports["now"])
        require(type(value) in (int, float) and math.isfinite(value) and value >= 0, "clock")
        require(value >= state.get("lastClock", value), "clock")
        state["lastClock"] = value
        return value

    def checked_directory(path):
        chain = list(reversed((PurePosixPath(path), *PurePosixPath(path).parents)))
        for item in chain:
            p = str(item)
            row = call("directory-metadata", ports["lstat_directory"], p)
            require(type(row) is dict and row.get("path") == row.get("realpath") == p and
                    row.get("directory") is True and type(row.get("uid")) is int and
                    row["uid"] in (0, uid) and
                    type(row.get("mode")) is int and 0 <= row["mode"] <= 0o177777 and
                    row["mode"] & 0o170000 == 0o040000 and
                    not row["mode"] & 0o7022 and
                    type(row.get("ino")) is int and 0 < row["ino"] <= 2**53 - 1 and
                    type(row.get("dev")) is int and 0 <= row["dev"] <= 2**53 - 1,
                    "directory-metadata")
            identity = tuple(row[key] for key in ("path", "realpath", "uid", "mode", "ino", "dev"))
            before = state["directoryIdentities"].setdefault(p, identity)
            require(identity == before, "directory-identity")

    try:
        packages = validate_runtime_inputs(source_lock_bytes, profile_bytes)
        for p in (install_root, archives_root, checkout_root):
            absolute(p)
        require(type(uid) is int and uid > 0, "uid")
        require(install_root.endswith("/validation/gateway-runtime/install") and
                archives_root == str(PurePosixPath(install_root).parent) + "/inputs/runtime-archives" and
                not (install_root == checkout_root or install_root.startswith(checkout_root + "/")),
                "installation-isolation")
        for key in ("now", "fetch", "lstat_directory", "mkdir_exclusive", "write_exclusive"):
            require(callable(ports.get(key)), "port-missing")
        checked_directory(install_root)
        checked_directory(str(PurePosixPath(archives_root).parent))
        state["phase"] = "fetch-and-verify"
        parsed, expanded_total, member_total = [], 0, 0
        for entry in packages:
            start = now()
            request = {"url": entry["url"], "maximumBytes": LIMITS["compressed"],
                       "timeoutSeconds": 15, "deadlineSeconds": LIMITS["secondsPerInput"],
                       "redirects": False, "retries": 0, "credentials": False,
                       "proxy": False, "customTrust": False}
            response = call("fetch", ports["fetch"], request)
            state["responses"].append(response)
            require(type(response) is dict and set(response) ==
                    {"status", "url", "length", "read", "close"} and
                    callable(response["read"]) and callable(response["close"]), "fetch-owner")
            primary = None
            chunks, total = [], 0
            try:
                require(response["status"] == 200 and response["url"] == entry["url"], "fetch-endpoint")
                length = response["length"]
                require(length is None or (type(length) is int and 0 < length <= LIMITS["compressed"]),
                        "fetch-length")
                while True:
                    require(now() - start <= LIMITS["secondsPerInput"], "fetch-deadline")
                    chunk = call("fetch-read", response["read"], 65536)
                    require(now() - start <= LIMITS["secondsPerInput"], "fetch-deadline")
                    require(type(chunk) is bytes and len(chunk) <= 65536, "fetch-chunk")
                    if not chunk:
                        break
                    total += len(chunk)
                    require(total <= LIMITS["compressed"] and
                            len(chunks) < LIMITS["chunksPerInput"], "fetch-length")
                    chunks.append(chunk)
                require(total > 0 and (length is None or total == length), "fetch-length")
            except BaseException as error:
                primary = error
            try:
                call("fetch-close", response["close"], acknowledgment=True)
            except BaseException as error:
                if primary is None:
                    primary = error
                else:
                    state.setdefault("secondary", []).append(error)
            if primary is not None:
                raise primary
            require(now() - start <= LIMITS["secondsPerInput"], "fetch-deadline")
            raw = b"".join(chunks)
            state["archives"].append({"path": "node_modules/" + entry["name"], "bytes": raw})
            item = inspect_runtime_archive(raw, entry)
            expanded_total += item["expandedBytes"]
            member_total += item["members"]
            require(expanded_total <= LIMITS["expandedTotal"] and
                    member_total <= LIMITS["entriesTotal"], "aggregate-bounds")
            parsed.append((entry, item))
        # No dependency mkdir/write occurs until ALL five originals pass the frozen pins/parser.
        state["phase"] = "materialization"
        checked_directory(install_root)
        checked_directory(str(PurePosixPath(archives_root).parent))
        call("archive-directory", ports["mkdir_exclusive"], archives_root, 0o700, acknowledgment=True)
        state["created"].append(archives_root)
        for index, row in enumerate(state["archives"], 1):
            call("archive-write", ports["write_exclusive"], archives_root + "/" + str(index) + ".tgz",
                 row["bytes"], 0o600, acknowledgment=True)
        modules = install_root + "/node_modules"
        call("modules-directory", ports["mkdir_exclusive"], modules, 0o700, acknowledgment=True)
        state["created"].append(modules)
        for entry, item in parsed:
            root = modules + "/" + entry["name"]
            dirs = set(item["directories"])
            for name in item["files"]:
                dirs.update(str(p) for p in PurePosixPath(name).parents if str(p) != ".")
            for directory in [""] + sorted(dirs, key=lambda x: (x.count("/"), x)):
                p = root + ("/" + directory if directory else "")
                call("package-directory", ports["mkdir_exclusive"], p, 0o700, acknowledgment=True)
                state["created"].append(p)
            for name, body in sorted(item["files"].items()):
                call("package-write", ports["write_exclusive"], root + "/" + name, body, 0o600,
                     acknowledgment=True)
                state["completedFiles"] += 1
        state["phase"], state["status"] = "complete", "prepared-inputs-not-runtime"
        return state
    except BaseException as error:
        state["status"] = "refused-custody-retained"
        if isinstance(error, RuntimeInputRefused):
            error.custody = state
            raise
        refused = RuntimeInputRefused("port-or-input-failure", state)
        raise refused from error

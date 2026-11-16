"""Physical ports for the frozen five-input preparer; no action on import.

Only the separate strict child entrypoint constructs these ports. Constructor
dependencies can be replaced with benign memory fakes; there are no retries,
chmod/chown/unlink operations, package scripts, subprocesses or Gateway launch.
"""

import http.client
import inspect
import math
import os
from pathlib import PurePosixPath
import re
import ssl
import stat
import time
from urllib.parse import urlsplit


NAMES = ("asn1", "bcrypt-pbkdf", "safer-buffer", "ssh2", "tweetnacl")
VERSIONS = ("0.2.6", "1.0.2", "2.1.2", "1.17.0", "0.14.5")
URLS = tuple("https://registry.npmjs.org/" + name + "/-/" + name + "-" + version + ".tgz"
             for name, version in zip(NAMES, VERSIONS))
TRUST_ENV = frozenset((
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir",
    "sslkeylogfile", "openssl_conf", "openssl_modules", "requests_ca_bundle", "curl_ca_bundle",
    "node_extra_ca_certs", "npm_config_proxy", "npm_config_https_proxy", "npm_config_noproxy",
    "npm_config_cafile", "npm_config_ca",
))


class NativePortRefused(ValueError):
    def __init__(self, reason, custody):
        self.reason, self.custody = reason, custody
        super().__init__("Native Gateway input port refused")


def canonical_path(value):
    return (type(value) is str and value.startswith("/") and len(value) <= 4096 and
            str(PurePosixPath(value)) == value and ".." not in value.split("/") and
            not re.search(r"[\\\x00-\x20\x7f]", value))


class NativeRuntimePorts:
    def __init__(self, uid, install_root, archives_root, checkout_root, packages, *,
                 environment=None, system=os, connection_factory=http.client.HTTPSConnection,
                 context_factory=ssl.create_default_context, clock=time.monotonic):
        self.system, self.connection_factory = system, connection_factory
        self.context_factory, self.clock = context_factory, clock
        self.uid, self.install_root, self.archives_root = uid, install_root, archives_root
        self.modules_root = install_root + "/node_modules"
        self.state = {"descriptors": [], "responses": [], "unknown": [], "secondary": [],
                      "attemptedPaths": set(), "createdDirectories": set(), "requestedURLs": set(),
                      "directoryIdentities": {}}
        self.require(type(uid) is int and uid > 0 and self.sync(system.getuid()) == uid, "identity")
        self.require(all(canonical_path(p) for p in (install_root, archives_root, checkout_root)) and
                     checkout_root != "/" and install_root.endswith("/validation/gateway-runtime/install") and
                     archives_root == str(PurePosixPath(install_root).parent) + "/inputs/runtime-archives" and
                     not (install_root == checkout_root or install_root.startswith(checkout_root + "/")),
                     "scope")
        self.require([entry.get("name") for entry in packages] == list(NAMES) and
                     [entry.get("url") for entry in packages] == list(URLS) and
                     [entry.get("version") for entry in packages] == list(VERSIONS), "scope")
        env = os.environ if environment is None else environment
        self.require(not any(str(key).lower() in TRUST_ENV for key in env), "trust-environment")
        self.created = self.state["createdDirectories"]

    def require(self, condition, reason):
        if not condition:
            raise NativePortRefused(reason, self.state)

    def sync(self, value):
        if inspect.isawaitable(value):
            self.state["unknown"].append(value)
            self.state["unsettledIO"] = True
            self.require(False, "unsupported-return")
        return value

    def ack(self, value):
        value = self.sync(value)
        if value is not None:
            self.state["unknown"].append(value)
            self.state["unsettledIO"] = True
            self.require(False, "unsupported-return")

    def now(self):
        value = self.sync(self.clock())
        self.require(type(value) in (int, float) and math.isfinite(value) and value >= 0 and
                     value >= self.state.get("lastClock", value), "clock")
        self.state["lastClock"] = value
        return value

    def _identity(self, row):
        # Directory link counts change when our exclusive child directories are created.
        # Files are independently required to retain nlink1 at every observation.
        return tuple(getattr(row, name) for name in ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode"))

    def _metadata(self, row, directory):
        for name in ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink", "st_size"):
            value = getattr(row, name)
            self.require(type(value) is int and 0 <= value <= 2**53 - 1, "metadata")
        self.require(row.st_ino > 0 and row.st_nlink > 0 and row.st_uid in (0, self.uid) and
                     row.st_mode <= 0o177777 and not row.st_mode & 0o7022 and
                     (stat.S_ISDIR(row.st_mode) if directory else stat.S_ISREG(row.st_mode)), "metadata")
        if not directory:
            self.require(row.st_uid == self.uid and row.st_nlink == 1, "metadata")
        return row

    def _fd(self, fn, *args, **kwargs):
        lease = {"fd": None, "closed": False, "issued": True}
        self.state["descriptors"].append(lease)  # Before an uncertain open.
        value = self.sync(fn(*args, **kwargs))
        lease["returned"] = value
        self.require(type(value) is int and value >= 0, "descriptor")
        lease["fd"] = value
        return lease

    def _close(self, lease):
        self.require(not lease.get("closeIssued"), "duplicate-close")
        lease["closeIssued"] = True
        self.ack(self.system.close(lease["fd"]))
        lease["closed"] = True

    def _finish(self, leases, primary):
        if self.state.get("unsettledIO"):
            # An unsupported asynchronous operation may still borrow these descriptors.
            # Retain them; closing/reusing them would invent completion of that operation.
            if primary is None:
                self.require(False, "unsettled-io")
            raise primary
        for lease in reversed(leases):
            if lease.get("fd") is not None and not lease.get("closeIssued"):
                try:
                    self._close(lease)
                except BaseException as error:
                    if primary is None:
                        primary = error
                    else:
                        self.state["secondary"].append(error)
        if primary is not None:
            raise primary

    def _directories(self, path, leases):
        self.require(canonical_path(path), "scope")
        flags = self.system.O_RDONLY | self.system.O_DIRECTORY | self.system.O_NOFOLLOW | self.system.O_NONBLOCK
        current, prefix = None, "/"
        for part in ["/"] + list(PurePosixPath(path).parts[1:]):
            if current is None:
                before = self._metadata(self.sync(self.system.lstat("/")), True)
                lease = self._fd(self.system.open, "/", flags)
            else:
                prefix = (prefix.rstrip("/") + "/" + part)
                before = self._metadata(self.sync(self.system.stat(part, dir_fd=current["fd"], follow_symlinks=False)), True)
                lease = self._fd(self.system.open, part, flags, dir_fd=current["fd"])
            leases.append(lease)
            after = self._metadata(self.sync(self.system.fstat(lease["fd"])), True)
            self.require(self._identity(before) == self._identity(after), "directory-identity")
            if prefix in (self.install_root, str(PurePosixPath(self.archives_root).parent)):
                self.require(after.st_uid == self.uid, "unowned-parent")
            identity = self._identity(after)
            baseline = self.state["directoryIdentities"].setdefault(prefix, identity)
            self.require(baseline == identity, "directory-identity")
            current = lease
        return current, after

    def lstat_directory(self, path):
        leases, primary, result = [], None, None
        try:
            _, row = self._directories(path, leases)
            result = {"path": path, "realpath": path, "uid": row.st_uid, "mode": row.st_mode,
                      "ino": row.st_ino, "dev": row.st_dev, "directory": True}
        except BaseException as error:
            primary = error
        self._finish(leases, primary)
        return result

    def _write_scope(self, path, directory):
        self.require(canonical_path(path), "scope")
        if path == self.archives_root or path == self.modules_root:
            self.require(directory, "scope")
            return
        if path.startswith(self.archives_root + "/"):
            self.require(not directory and path[len(self.archives_root) + 1:] in
                         ("1.tgz", "2.tgz", "3.tgz", "4.tgz", "5.tgz"), "scope")
            return
        self.require(path.startswith(self.modules_root + "/"), "scope")
        relative = path[len(self.modules_root) + 1:].split("/")
        self.require(relative[0] in NAMES and (directory or len(relative) > 1) and
                     all(part and part not in (".", "..") and not part.endswith((" ", ".")) and
                         ":" not in part for part in relative) and
                     "node_modules" not in [part.lower() for part in relative[1:]] and
                     not relative[-1].lower().endswith(".node"), "scope")

    def _parent(self, path, leases):
        parent = str(PurePosixPath(path).parent)
        outer = {self.install_root, str(PurePosixPath(self.archives_root).parent)}
        self.require(parent in self.created or parent in outer, "unowned-parent")
        lease, before = self._directories(parent, leases)
        return lease, before, parent

    def _parent_still(self, parent, before, leases):
        _, after = self._directories(parent, leases)
        self.require(self._identity(before) == self._identity(after), "directory-identity")

    def mkdir_exclusive(self, path, mode):
        self._write_scope(path, True)
        self.require(mode == 0o700 and path not in self.state["attemptedPaths"], "scope")
        self.state["attemptedPaths"].add(path)
        leases, primary = [], None
        try:
            parent, before, parent_path = self._parent(path, leases)
            name = PurePosixPath(path).name
            self.ack(self.system.mkdir(name, mode=0o700, dir_fd=parent["fd"]))
            row = self._metadata(self.sync(self.system.stat(name, dir_fd=parent["fd"], follow_symlinks=False)), True)
            self.require(row.st_uid == self.uid and stat.S_IMODE(row.st_mode) == 0o700, "created-mode")
            self._parent_still(parent_path, before, leases)
            self.created.add(path)
        except BaseException as error:
            primary = error
        self._finish(leases, primary)

    def write_exclusive(self, path, body, mode):
        self._write_scope(path, False)
        self.require(type(body) is bytes and len(body) <= 32 * 1024**2 and mode == 0o600 and
                     path not in self.state["attemptedPaths"], "scope")
        self.require(not path.startswith(self.archives_root + "/") or len(body) <= 16 * 1024**2, "scope")
        self.state["attemptedPaths"].add(path)
        leases, primary = [], None
        try:
            parent, before, parent_path = self._parent(path, leases)
            flags = self.system.O_WRONLY | self.system.O_CREAT | self.system.O_EXCL | self.system.O_NOFOLLOW | self.system.O_NONBLOCK
            file = self._fd(self.system.open, PurePosixPath(path).name, flags, 0o600, dir_fd=parent["fd"])
            leases.append(file)
            initial = self._metadata(self.sync(self.system.fstat(file["fd"])), False)
            self.require(initial.st_size == 0 and stat.S_IMODE(initial.st_mode) == 0o600, "created-mode")
            offset = 0
            while offset < len(body):
                count = self.sync(self.system.write(file["fd"], memoryview(body)[offset:]))
                self.require(type(count) is int and 0 < count <= len(body) - offset, "partial-write")
                offset += count
            self.ack(self.system.fsync(file["fd"]))
            final = self._metadata(self.sync(self.system.fstat(file["fd"])), False)
            named = self._metadata(self.sync(self.system.stat(PurePosixPath(path).name, dir_fd=parent["fd"], follow_symlinks=False)), False)
            self.require(self._identity(initial) == self._identity(final) == self._identity(named) and
                         final.st_size == named.st_size == len(body), "file-identity")
            self._parent_still(parent_path, before, leases)
        except BaseException as error:
            primary = error
        self._finish(leases, primary)

    def fetch(self, request):
        self.require(type(request) is dict and set(request) == {"url", "maximumBytes", "timeoutSeconds",
                     "deadlineSeconds", "redirects", "retries", "credentials", "proxy", "customTrust"} and
                     request.get("url") in URLS and type(request.get("maximumBytes")) is int and
                     request["maximumBytes"] == 16 * 1024**2 and type(request.get("timeoutSeconds")) is int and
                     request["timeoutSeconds"] == 15 and type(request.get("deadlineSeconds")) is int and
                     request["deadlineSeconds"] == 45 and request.get("redirects") is False and
                     type(request.get("retries")) is int and request["retries"] == 0 and
                     request.get("credentials") is request.get("proxy") is request.get("customTrust") is False,
                     "request")
        url = request["url"]
        self.require(url not in self.state["requestedURLs"], "duplicate-request")
        self.state["requestedURLs"].add(url)  # Never retry an uncertain request.
        owner = {"connection": None, "response": None, "closed": False, "closeIssued": False,
                 "bytes": 0, "chunks": 0, "started": self.now()}
        self.state["responses"].append(owner)

        def within():
            self.require(self.now() - owner["started"] <= 45, "deadline")

        def close():
            self.require(not owner["closeIssued"], "duplicate-close")
            owner["closeIssued"] = True
            if self.state.get("unsettledIO"):
                # An unsupported request/read/getresponse may still borrow both owners.
                # Do not manufacture its completion by closing the underlying connection.
                owner["closeRefusedUnsettled"] = True
                self.require(False, "unsettled-io")
            primary = None
            for key in ("response", "connection"):
                if self.state.get("unsettledIO"):
                    # A close submission itself can return an unsupported awaitable.
                    # Retain the remaining owner instead of closing beneath that borrower.
                    owner["closeRefusedUnsettled"] = True
                    break
                item = owner[key]
                if item is None:
                    continue
                try:
                    owner[key + "CloseIssued"] = True
                    self.ack(item.close())
                    owner[key + "Closed"] = True
                except BaseException as error:
                    if primary is None:
                        primary = error
                    else:
                        self.state["secondary"].append(error)
            if primary is not None:
                raise primary
            owner["closed"] = True

        try:
            context = self.sync(self.context_factory())
            owner["context"] = context
            self.require(context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname is True and
                         getattr(context, "keylog_filename", None) is None, "tls-context")
            connection = self.sync(self.connection_factory("registry.npmjs.org", port=443, timeout=15, context=context))
            owner["connection"] = connection
            within()
            parts = urlsplit(url)
            self.ack(connection.request("GET", parts.path, body=None, headers={
                "Accept": "application/octet-stream", "Accept-Encoding": "identity",
                "Connection": "close", "User-Agent": "DiagnosticHub-RuntimeInputs"}))
            within()
            response = self.sync(connection.getresponse())
            owner["response"] = response
            within()
            self.require(type(response.status) is int and response.status == 200, "http-status")
            encoding = self.sync(response.getheader("Content-Encoding"))
            self.require(encoding in (None, "identity"), "http-encoding")
            length = self.sync(response.getheader("Content-Length"))
            self.require(length is None or (type(length) is str and length.isascii() and
                         len(length) <= 10 and length.isdecimal() and
                         0 < int(length) <= request["maximumBytes"]), "http-length")
            length = None if length is None else int(length)

            def read(maximum):
                self.require(not owner["closeIssued"] and type(maximum) is int and 0 < maximum <= 65536,
                             "read-request")
                within()
                data = self.sync(response.read(maximum))
                within()
                self.require(type(data) is bytes and len(data) <= maximum, "read-return")
                if data:
                    owner["bytes"] += len(data)
                    owner["chunks"] += 1
                    self.require(owner["bytes"] <= request["maximumBytes"] and owner["chunks"] <= 4096,
                                 "read-bounds")
                else:
                    self.require(owner["bytes"] > 0 and (length is None or owner["bytes"] == length),
                                 "read-length")
                return data

            return {"status": 200, "url": url, "length": length, "read": read, "close": close}
        except BaseException as primary:
            if not owner["closeIssued"]:
                try:
                    close()
                except BaseException as error:
                    self.state["secondary"].append(error)
            raise primary

    def ports(self):
        return {"now": self.now, "fetch": self.fetch, "lstat_directory": self.lstat_directory,
                "mkdir_exclusive": self.mkdir_exclusive, "write_exclusive": self.write_exclusive}

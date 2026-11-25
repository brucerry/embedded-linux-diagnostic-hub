"""Stage the existing compiler-spike lockfile without resolving new versions."""
import base64
import hashlib
import hmac
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
from urllib.parse import urlparse
from urllib.request import urlopen

if not __debug__:
    raise RuntimeError('Archive verifier requires assertions enabled')
root = Path(sys.argv[1]).resolve(strict=True)
assert len(sys.argv) == 2
pins = json.loads((root / "package-lock.json").read_bytes())["packages"]
entries = [(key, meta) for key, meta in pins.items() if key]
assert len(entries) in (15, 36, 43)
fixture_pins = {"node_modules/js-yaml", "node_modules/argparse", "node_modules/typescript"}
assert fixture_pins.intersection(pins) == (fixture_pins if len(entries) >= 36 else set())
renderer_pins = {"node_modules/" + name for name in (
    "@vitejs/plugin-react", "react", "react-dom", "lucide-react", "scheduler", "@xterm/xterm", "@xterm/addon-fit")}
assert renderer_pins.intersection(pins) == (renderer_pins if len(entries) == 43 else set())
for key, meta in sorted(entries, key=lambda item: (item[0].count('/'), item[0])):
    parts = PurePosixPath(key).parts
    assert parts[0] == "node_modules" and all(p not in (".", "..", "esbuild", "@esbuild", "ssh2", "app-builder-lib") and "\\" not in p and ":" not in p for p in parts)
    assert not meta.get("link") and not meta.get("hasInstallScript")
    url = urlparse(meta["resolved"])
    assert url.scheme == "https" and url.netloc == "registry.npmjs.org"
    with urlopen(url.geturl(), timeout=20) as response:
        final = urlparse(response.geturl())
        assert final.scheme == "https" and final.netloc == "registry.npmjs.org"
        data = response.read(32 * 1024 * 1024 + 1)
    assert 0 < len(data) <= 32 * 1024 * 1024
    digest = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")
    assert hmac.compare_digest(digest, meta["integrity"]), key
    dest = root.joinpath(*parts)
    dest.mkdir(parents=True, exist_ok=False)
    seen = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            assert path.parts and path.parts[0] == "package" and all(p not in (".", "..") and "\\" not in p and ":" not in p for p in path.parts)
            relative = path.parts[1:]
            assert relative or member.isdir()
            assert relative not in seen
            seen.add(relative)
            assert len(seen) <= 20000
            target = dest.joinpath(*relative)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                assert member.isfile() and 0 <= member.size <= 128 * 1024 * 1024
                total += member.size
                assert total <= 128 * 1024 * 1024
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    output.write(source.read())
    manifest = json.loads((dest / "package.json").read_bytes())
    assert manifest["version"] == meta["version"], key
    print("Verified and staged", key, flush=True)

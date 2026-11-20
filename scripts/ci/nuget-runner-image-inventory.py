"""Check only hosted runner metadata and reviewed publisher inventory."""

import os
from pathlib import Path
import sys

SDK = "10.0.404"
# actions/runner-images Ubuntu2404-Readme.md, November 11 and 16 images.
PUBLISHED_SDKS = (
    "8.0.134", "8.0.206", "8.0.319", "8.0.428", "9.0.124", "9.0.205",
    "9.0.321", "10.0.115", "10.0.204", "10.0.303", "10.0.404", "11.0.100",
)
APPROVED_IMAGES = {
    "20261111.370.1": PUBLISHED_SDKS,  # fb099341ddaf44a428fb17495341cb7c2300faf2
    "20261116.376.1": PUBLISHED_SDKS,  # 27322eb5268668e27e64007fdd1353ec7387dc0b
}


class Refused(Exception):
    """Allowlisted status safe to report."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def check_identity(env, uid, effective_uid):
    require(env.get("RUNNER_ENVIRONMENT") == "github-hosted"
            and uid == effective_uid and uid > 0, "host-identity")


def check_platform(env, arch, release):
    require(env.get("RUNNER_OS") == "Linux" and env.get("RUNNER_ARCH") == "X64"
            and arch == "x86_64" and env.get("ImageOS") == "ubuntu24", "host-platform")
    require(len(release) <= 8192 and "ID=ubuntu" in release.splitlines()
            and 'VERSION_ID="24.04"' in release.splitlines(), "host-operating-system")


def select_image(env):
    image = env.get("ImageVersion")
    require(image in APPROVED_IMAGES, "unreviewed-image-revision")
    return image


def check_published_inventory(env, expected_image):
    image = select_image(env)
    require(image == expected_image and SDK in APPROVED_IMAGES[image], "published-sdk-inventory")


def run(args):
    if args == ["identity"]:
        check_identity(os.environ, os.getuid(), os.geteuid())
        return "host-identity-ready"
    if args == ["platform"]:
        with Path("/etc/os-release").open("r", encoding="utf-8") as input_stream:
            check_platform(os.environ, os.uname().machine, input_stream.read(8193))
        return "ubuntu-24.04-x64-platform-ready"
    if args == ["image"]:
        image = select_image(os.environ)
        with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="ascii") as output_stream:
            output_stream.write(f"image={image}\n")
        return "reviewed-image-revision-ready"
    if len(args) == 2 and args[0] == "published":
        check_published_inventory(os.environ, args[1])
        return "sdk-10.0.404-listed-in-published-image-inventory"
    raise Refused("unknown-inventory-stage")


if __name__ == "__main__":
    try:
        print(run(sys.argv[1:]))
    except Refused as exc:
        print(f"held {exc}")
        raise SystemExit(1) from None
    except (OSError, KeyError, UnicodeError):
        print("held inventory-local-input")
        raise SystemExit(1) from None

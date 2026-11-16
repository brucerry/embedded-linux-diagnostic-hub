"""Branch-specific wrapper; publisher/provider/common checks remain unchanged."""

import importlib.util
from pathlib import Path


BRANCH = "ci/v060-gateway-health-smoke-20261116"
_SPEC = importlib.util.spec_from_file_location(
    "gateway_publisher_health_preparation", Path(__file__).with_name("prepare-gateway-publisher-node.py"))
P = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(P)


def entry(publisher=P):
    return publisher.COMMON.collect_diagnostic(node_provider=publisher.acquire_node, expected_branch=BRANCH)


if __name__ == "__main__":
    raise SystemExit(entry())

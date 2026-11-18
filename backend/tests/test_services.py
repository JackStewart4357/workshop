"""Every deployable service must import cleanly and have its own API test file.

Coverage only reports code that some test imports; this stops a new service from
shipping with no tests while the coverage figure still looks perfect.
"""

import pytest

from conftest import BACKEND_DIR, load_service

SERVICES = sorted(
    path.parent.name for path in BACKEND_DIR.glob("*/requirements.txt") if path.parent.name[0] not in "_."
)


def test_services_are_discovered():
    assert "auth" in SERVICES


@pytest.mark.parametrize("name", SERVICES)
def test_service_imports_and_has_tests(name):
    assert callable(load_service(name).handler)
    assert (BACKEND_DIR / "tests" / f"test_{name}_api.py").exists(), f"no tests/test_{name}_api.py for service {name}"

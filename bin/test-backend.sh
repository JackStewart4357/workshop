#!/usr/bin/env bash
# Script: Run Backend Tests
# Purpose: Run the backend test suite with coverage; fails below 80% coverage
# Usage: ./test-backend.sh [pytest options]
#
# Needs a running PostgreSQL (./bin/start-dev.sh starts one). Tests use a throwaway
# schema and never touch application data. Any arguments are passed on to pytest;
# for a quick run of a subset without the coverage gate, call pytest directly:
#   cd backend && .venv/bin/pytest tests/test_auth_api.py -k login

set -e

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0 [pytest options]"
    echo "Run the backend test suite with coverage (fails below 80%)"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" > /dev/null 2>&1 || exit 1; pwd -P)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" > /dev/null 2>&1 || exit 1; pwd -P)"
cd "$BACKEND_DIR"

# Same interpreter as the Lambda runtime (see infra/locals.tf)
PYTHON="$(command -v python3.13 || command -v python3 || true)"

# (Re)install test dependencies when requirements change
REQS_HASH="$(cat requirements-dev.txt */requirements.txt | cksum)"
if [ ! -x .venv/bin/pytest ] || [ "$(cat .venv/.requirements-hash 2>/dev/null)" != "$REQS_HASH" ]; then
    echo "Setting up backend/.venv ..."
    # Rebuild a venv left half-made by an interrupted setup, or made by another Python version
    pyver() { "$1" -c 'import sys; print(sys.version_info[:2])' 2> /dev/null; }
    if ! .venv/bin/python -m pip --version > /dev/null 2>&1 \
        || { [ -n "$PYTHON" ] && [ "$(pyver .venv/bin/python)" != "$(pyver "$PYTHON")" ]; }; then
        [ -n "$PYTHON" ] || { echo "ERROR: python3.13 (or python3) not found" >&2; exit 1; }
        "$PYTHON" -m venv --clear .venv
    fi
    # Test tools plus every service's own requirements (same folder rule as Terraform)
    req_args=(-r requirements-dev.txt)
    for req in */requirements.txt; do
        case "$req" in _*|.*) continue ;; esac
        req_args+=(-r "$req")
    done
    .venv/bin/python -m pip install --quiet --disable-pip-version-check "${req_args[@]}"
    echo "$REQS_HASH" > .venv/.requirements-hash
fi

# Own coverage data file per run: two runs at once must not share backend/.coverage
export COVERAGE_FILE="${TMPDIR:-/tmp}/backend-coverage.$$"
trap 'rm -f "$COVERAGE_FILE"' EXIT
.venv/bin/pytest --cov --cov-config=.coveragerc --cov-report=term-missing --cov-fail-under=80 "$@"

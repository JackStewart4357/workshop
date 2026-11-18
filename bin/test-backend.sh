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
PYTHON="$(command -v python3.13 || command -v python3)"

# (Re)install test dependencies when requirements change
REQS_HASH="$(cat requirements-dev.txt */requirements.txt | cksum)"
if [ ! -x .venv/bin/pytest ] || [ "$(cat .venv/.requirements-hash 2>/dev/null)" != "$REQS_HASH" ]; then
    echo "Setting up backend/.venv ..."
    [ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
    .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements-dev.txt
    echo "$REQS_HASH" > .venv/.requirements-hash
fi

exec .venv/bin/pytest --cov --cov-config=.coveragerc --cov-report=term-missing --cov-fail-under=80 "$@"

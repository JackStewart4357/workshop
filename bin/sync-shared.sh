#!/usr/bin/env bash
# Script: Sync Shared Backend Code
# Purpose: Copy backend/_shared/*.py into every Python backend service
# Usage: ./sync-shared.sh
#
# Each folder under backend/ is packaged as its own Lambda and cannot import from a
# sibling folder, so code used by several services lives once in backend/_shared and
# is copied into each service before it is run or deployed. The copies are git-ignored:
# always edit the file in backend/_shared, then run this script again.

set -e

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0"
    echo "Copy backend/_shared/*.py into every Python backend service"
    exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" > /dev/null 2>&1 || exit 1; pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." > /dev/null 2>&1 || exit 1; pwd -P)"
BACKEND_DIR="$PROJECT_ROOT/backend"
SHARED_DIR="$BACKEND_DIR/_shared"

shopt -s nullglob
shared_files=("$SHARED_DIR"/*.py)
if [ ${#shared_files[@]} -eq 0 ]; then
    echo "ERROR: no shared modules found in $SHARED_DIR"
    exit 1
fi

HEADER_PREFIX="# AUTO-COPIED from backend/_shared/"

for req in "$BACKEND_DIR"/*/requirements.txt; do
    svc_dir="$(dirname "$req")"
    svc_name="$(basename "$svc_dir")"
    # Same rule Terraform uses to discover services: skip _private and .hidden folders
    case "$svc_name" in _*|.*) continue ;; esac

    # Everything this script and start-dev.sh generate in a service folder must stay out
    # of git. A new service gets the same allowlist backend/auth uses.
    if [ ! -e "$svc_dir/.gitignore" ]; then
        printf '%s\n' \
            "# Only this service's own source is tracked. Everything else in this folder is generated" \
            "# (pip packages from start-dev.sh, shared modules copied by bin/sync-shared.sh)." \
            "# Add a '!/<file>' line for every other source file this service owns." \
            '/*' '!/.gitignore' '!/requirements.txt' '!/function.py' > "$svc_dir/.gitignore"
        echo "  Created backend/$svc_name/.gitignore"
    fi

    # Remove copies whose original was deleted or renamed in backend/_shared
    for old in "$svc_dir"/*.py; do
        if [ ! -e "$SHARED_DIR/$(basename "$old")" ] && head -n 1 "$old" | grep -q "^$HEADER_PREFIX"; then
            rm -f "$old"
            echo "  Removed stale copy backend/$svc_name/$(basename "$old")"
        fi
    done

    for src in "${shared_files[@]}"; do
        name="$(basename "$src")"
        dest="$svc_dir/$name"
        # Only ever overwrite a file this script wrote: never a service's own module
        if [ -e "$dest" ] && ! head -n 1 "$dest" | grep -q "^$HEADER_PREFIX"; then
            echo "ERROR: backend/$svc_name/$name exists and is not a copy made by this script."
            echo "       It has the same name as backend/_shared/$name: rename one of the two files."
            exit 1
        fi
        tmp="$dest.tmp.$$"
        {
            echo "$HEADER_PREFIX$name by bin/sync-shared.sh."
            echo "# Do not edit this copy: edit the original and run ./bin/sync-shared.sh"
            cat "$src"
        } > "$tmp"
        # Leave an identical copy alone so its mtime does not change (no needless Lambda reload)
        if cmp -s "$tmp" "$dest"; then
            rm -f "$tmp"
        else
            mv -f "$tmp" "$dest"
        fi
    done
    echo "  Synced ${#shared_files[@]} shared module(s) into backend/$svc_name"
done

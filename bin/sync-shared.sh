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
DB_DIR="$BACKEND_DIR/_db"

shopt -s nullglob
shared_files=("$SHARED_DIR"/*.py)
if [ ${#shared_files[@]} -eq 0 ]; then
    echo "ERROR: no shared modules found in $SHARED_DIR" >&2
    exit 1
fi

HEADER_PREFIX="# AUTO-COPIED from backend/_shared/"

# True when file $1 is this script's copy of the shared module named $2
is_copy_of() {
    [ "$(head -n 1 "$1" 2> /dev/null)" = "$HEADER_PREFIX$2 by bin/sync-shared.sh." ]
}

# The copy of shared module $1 (path) named $2, on stdout
render() {
    echo "$HEADER_PREFIX$2 by bin/sync-shared.sh."
    echo "# Do not edit this copy: edit the original and run ./bin/sync-shared.sh"
    cat "$1"
}

tmp=""
trap '[ -z "$tmp" ] || rm -f "$tmp"' EXIT

for req in "$BACKEND_DIR"/*/requirements.txt; do
    svc_dir="$(dirname "$req")"
    svc_name="$(basename "$svc_dir")"
    # Same rule Terraform uses to discover services: skip _private and .hidden folders
    case "$svc_name" in _*|.*) continue ;; esac

    # Everything this script and start-dev.sh generate in a service folder must stay out
    # of git. A new service gets the same allowlist backend/auth uses.
    if [ ! -e "$svc_dir/.gitignore" ]; then
        # Keep whatever the service already owns visible to git: an allowlist that
        # silently hid an existing helper module would drop it from the next commit.
        own=()
        for entry in "$svc_dir"/*; do
            entry_name="$(basename "$entry")"
            case "$entry_name" in requirements.txt|function.py|__pycache__|*.dist-info) continue ;; esac
            is_copy_of "$entry" "$entry_name" && continue
            own+=("!/$entry_name")
        done
        printf '%s\n' \
            "# Only this service's own source is tracked. Everything else in this folder is generated" \
            "# (pip packages from start-dev.sh, shared modules copied by bin/sync-shared.sh)." \
            "# Add a '!/<file>' line for every other source file this service owns." \
            '/*' '!/.gitignore' '!/requirements.txt' '!/function.py' "${own[@]}" > "$svc_dir/.gitignore"
        echo "  Created backend/$svc_name/.gitignore"
    fi

    # Remove copies whose original was deleted or renamed in backend/_shared
    for old in "$svc_dir"/*.py; do
        if [ ! -e "$SHARED_DIR/$(basename "$old")" ] && is_copy_of "$old" "$(basename "$old")"; then
            rm -f "$old"
            echo "  Removed stale copy backend/$svc_name/$(basename "$old")"
        fi
    done

    for src in "${shared_files[@]}"; do
        name="$(basename "$src")"
        dest="$svc_dir/$name"
        # Only ever overwrite a file this script wrote: never a service's own module
        if [ -e "$dest" ] || [ -L "$dest" ]; then
            if ! is_copy_of "$dest" "$name"; then
                echo "ERROR: backend/$svc_name/$name exists and is not a copy made by this script." >&2
                echo "       It has the same name as backend/_shared/$name: rename one of the two files." >&2
                exit 1
            fi
            # Leave an identical copy alone: writing anything into the folder, even a
            # temporary file, makes LocalStack hot-reload the Lambda.
            if render "$src" "$name" | cmp -s - "$dest"; then
                continue
            fi
        fi
        # Hidden name: Terraform does not package dotfiles and *.py globs do not see it
        tmp="$svc_dir/.$name.tmp.$$"
        render "$src" "$name" > "$tmp"
        mv -f "$tmp" "$dest"
        tmp=""
    done
    echo "  Synced ${#shared_files[@]} shared module(s) into backend/$svc_name"

    # dbsetup applies the schema (and, when asked, the demo data) from inside the VPC, so it
    # is packaged with its own copies
    if [ "$svc_name" = "dbsetup" ]; then
        for sql in schema.sql seed.sql; do
            if ! cmp -s "$DB_DIR/$sql" "$svc_dir/$sql"; then
                tmp="$svc_dir/.$sql.tmp.$$"
                cp "$DB_DIR/$sql" "$tmp"
                mv -f "$tmp" "$svc_dir/$sql"
                tmp=""
                echo "  Copied backend/_db/$sql into backend/$svc_name"
            fi
        done
    fi
done

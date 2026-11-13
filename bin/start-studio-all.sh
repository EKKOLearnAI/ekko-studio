#!/usr/bin/env bash

set -u

if [[ -n "${HERMES_PATCH_SCRIPT:-}" ]]; then
  if [[ ! -f "$HERMES_PATCH_SCRIPT" ]]; then
    printf '[studio] optional Hermes patch not found: %s\n' "$HERMES_PATCH_SCRIPT" >&2
  elif ! bash "$HERMES_PATCH_SCRIPT"; then
    printf '[studio] optional Hermes patch failed; continuing without it\n' >&2
  fi
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../dist/server/index.js" "$@"

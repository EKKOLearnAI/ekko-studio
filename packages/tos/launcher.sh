#!/bin/bash
set -e
app_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$app_root/depends/bin:$PATH"
exec "$app_root/depends/bin/node" "$app_root/depends/webui/dist/server/index.js"

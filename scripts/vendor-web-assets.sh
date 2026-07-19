#!/usr/bin/env bash
# Refresh the vendored xterm.js UMD build + CSS embedded in the amber binary
# (crates/amber/assets/, include_bytes!). No CDN: `amber web` must work offline.
# Run after bumping @xterm/xterm in app/package.json.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/app/node_modules/@xterm/xterm"
dst="$root/crates/amber/assets"

[ -f "$src/lib/xterm.js" ] || { echo "missing $src/lib/xterm.js — run 'npm install' in app/ first" >&2; exit 1; }

cp "$src/lib/xterm.js" "$dst/xterm.js"
cp "$src/css/xterm.css" "$dst/xterm.css"

# A truncated/placeholder copy would silently ship a broken page.
[ "$(wc -c <"$dst/xterm.js")" -gt 100000 ] || { echo "vendored xterm.js looks too small" >&2; exit 1; }

ver="$(node -p "require('$src/package.json').version" 2>/dev/null || echo '?')"
echo "vendored @xterm/xterm $ver -> $dst"

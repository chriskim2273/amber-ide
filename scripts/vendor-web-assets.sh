#!/usr/bin/env bash
# Refresh the vendored xterm.js UMD build, Unicode grapheme addon, and CSS embedded in the amber binary
# (crates/amber/assets/, include_bytes!). No CDN: `amber web` must work offline.
# Run after bumping @xterm/xterm in app/package.json.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/app/node_modules/@xterm/xterm"
unicode_src="$root/app/node_modules/@xterm/addon-unicode-graphemes"
dst="$root/crates/amber/assets"

[ -f "$src/lib/xterm.js" ] || { echo "missing $src/lib/xterm.js — run 'npm install' in app/ first" >&2; exit 1; }
[ -f "$unicode_src/lib/addon-unicode-graphemes.js" ] || { echo "missing Unicode grapheme addon — run 'npm install' in app/ first" >&2; exit 1; }

cp "$src/lib/xterm.js" "$dst/xterm.js"
cp "$src/css/xterm.css" "$dst/xterm.css"
cp "$unicode_src/lib/addon-unicode-graphemes.js" "$dst/xterm-unicode-graphemes.js"

# A truncated/placeholder copy would silently ship a broken page.
[ "$(wc -c <"$dst/xterm.js")" -gt 100000 ] || { echo "vendored xterm.js looks too small" >&2; exit 1; }
[ "$(wc -c <"$dst/xterm-unicode-graphemes.js")" -gt 10000 ] || { echo "vendored Unicode grapheme addon looks too small" >&2; exit 1; }

ver="$(node -p "require('$src/package.json').version" 2>/dev/null || echo '?')"
unicode_ver="$(node -p "require('$unicode_src/package.json').version" 2>/dev/null || echo '?')"
echo "vendored @xterm/xterm $ver + @xterm/addon-unicode-graphemes $unicode_ver -> $dst"

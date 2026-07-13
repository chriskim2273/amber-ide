#!/usr/bin/env bash
# Package the amber-ide app: build the release `amber` binary, bundle it into
# the app resources, then build + package with electron-builder.
#
# Produces a host-platform installer (Linux AppImage / macOS dmg). The bundled
# `amber` is the host build; cross-platform release binaries come from the
# daemon's own scripts/dist.sh (static musl / universal) — swap those in for a
# real cross-platform distribution.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"

echo "==> building amber release binary"
( cd "$ROOT_DIR" && cargo build --release -p amber )

echo "==> bundling amber into app resources"
mkdir -p "$APP_DIR/resources/bin"
cp "$ROOT_DIR/target/release/amber" "$APP_DIR/resources/bin/amber"
chmod +x "$APP_DIR/resources/bin/amber"

echo "==> building renderer/main/preload"
( cd "$APP_DIR" && npm run build )

echo "==> packaging with electron-builder"
( cd "$APP_DIR" && npx electron-builder )

echo "==> artifacts:"
ls -la "$APP_DIR/release" 2>/dev/null || true

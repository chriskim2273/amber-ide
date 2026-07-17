#!/usr/bin/env bash
# Package the amber-ide app: obtain the *distributable* `amber` binary, bundle it
# into the app resources, then build + package with electron-builder.
#
# The bundled binary is the SAME artifact the daemon's own scripts/dist.sh
# produces — fully static (musl, zero deps) on Linux, universal (x86_64 + arm64)
# on macOS — NOT a host glibc-dynamic build. This is what ships inside the app
# bundle and gets installed to the user's machine, so it must run on any
# distro/arch of that OS. See docs/superpowers/specs/2026-07-13-amber-ide-app-design.md §6/§9.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"

os="$(uname -s)"

echo "==> building distributable amber binary (scripts/dist.sh)"
case "$os" in
    Linux)
        if ! rustup target list --installed 2>/dev/null | grep -q '^x86_64-unknown-linux-musl$'; then
            cat >&2 <<'EOF'
error: the static-musl Rust target is required to bundle a distributable amber.
       The app must ship a fully static binary, not a host glibc build (a glibc
       binary would only run on the build host's libc — the original packaging bug).

       Install it with:
         rustup target add x86_64-unknown-linux-musl

       (scripts/dist.sh will add the target too, but we check up front so this
       fails with a clear message instead of deep inside the build.)
EOF
            exit 1
        fi
        bash "$ROOT_DIR/scripts/dist.sh"
        SRC="$ROOT_DIR/dist/amber-linux-x86_64"
        ;;
    Darwin)
        bash "$ROOT_DIR/scripts/dist.sh"
        if [ "${AMBER_MACOS_INTEL:-0}" = "1" ]; then
            SRC="$ROOT_DIR/dist/amber-x86_64-apple-darwin"
        else
            SRC="$ROOT_DIR/dist/amber-macos-universal"
        fi
        ;;
    *)
        echo "error: unsupported OS: $os" >&2
        exit 1
        ;;
esac

if [ ! -f "$SRC" ]; then
    echo "error: expected distributable amber at $SRC but it was not produced" >&2
    exit 1
fi

# On Linux, assert the artifact is actually static. This catches the silent
# glibc-fallback bug even when the musl target is present but the build somehow
# produced a dynamic binary — a stronger guarantee than the up-front target check.
if [ "$os" = "Linux" ]; then
    if ! file "$SRC" | grep -Eq 'static-pie linked|statically linked'; then
        echo "error: $SRC is not statically linked:" >&2
        file "$SRC" >&2
        echo "       refusing to bundle a glibc-dynamic amber (the original packaging bug)." >&2
        exit 1
    fi
    echo "==> verified static: $(file "$SRC")"
fi

echo "==> bundling amber into app resources"
mkdir -p "$APP_DIR/resources/bin"
cp "$SRC" "$APP_DIR/resources/bin/amber"
chmod +x "$APP_DIR/resources/bin/amber"

echo "==> building renderer/main/preload"
( cd "$APP_DIR" && npm run build )

echo "==> packaging with electron-builder"
( cd "$APP_DIR" && npx electron-builder )

echo "==> artifacts:"
ls -la "$APP_DIR/release" 2>/dev/null || true

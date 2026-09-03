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
DIST_DIR="${AMBER_DIST_DIR:-$ROOT_DIR/dist}"
if [[ "$DIST_DIR" != /* ]]; then
    DIST_DIR="$ROOT_DIR/$DIST_DIR"
fi

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
        AMBER_DIST_DIR="$DIST_DIR" bash "$ROOT_DIR/scripts/dist.sh"
        SRC="$DIST_DIR/amber-linux-x86_64"
        ROUTER_SRC="$DIST_DIR/amber-router-linux-x86_64"
        ;;
    Darwin)
        AMBER_DIST_DIR="$DIST_DIR" bash "$ROOT_DIR/scripts/dist.sh"
        if [ "${AMBER_MACOS_INTEL:-0}" = "1" ]; then
            SRC="$DIST_DIR/amber-x86_64-apple-darwin"
            ROUTER_SRC="$DIST_DIR/amber-router-x86_64-apple-darwin"
        else
            SRC="$DIST_DIR/amber-macos-universal"
            ROUTER_SRC="$DIST_DIR/amber-router-macos-universal"
        fi
        ;;
    MINGW*|MSYS*|CYGWIN*)
        AMBER_DIST_DIR="$DIST_DIR" bash "$ROOT_DIR/scripts/dist.sh"
        SRC="$DIST_DIR/amber-windows-x86_64.exe"
        DAEMON_SRC="$DIST_DIR/amberd-windows-x86_64.exe"
        ROUTER_SRC="$DIST_DIR/amber-router-windows-x86_64.exe"
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

if [ ! -f "$ROUTER_SRC" ]; then
    echo "error: expected distributable amber-router at $ROUTER_SRC but it was not produced" >&2
    exit 1
fi

if [ "${DAEMON_SRC:-}" ] && [ ! -f "$DAEMON_SRC" ]; then
    echo "error: expected windowless amber daemon at $DAEMON_SRC but it was not produced" >&2
    exit 1
fi

# On Linux, assert the artifact is actually static. This catches the silent
# glibc-fallback bug even when the musl target is present but the build somehow
# produced a dynamic binary — a stronger guarantee than the up-front target check.
if [ "$os" = "Linux" ]; then
    for artifact in "$SRC" "$ROUTER_SRC"; do
        if ! file "$artifact" | grep -Eq 'static-pie linked|statically linked'; then
            echo "error: $artifact is not statically linked:" >&2
            file "$artifact" >&2
            echo "       refusing to bundle a glibc-dynamic binary (the original packaging bug)." >&2
            exit 1
        fi
        echo "==> verified static: $(file "$artifact")"
    done
fi

echo "==> bundling amber into app resources"
mkdir -p "$APP_DIR/resources/bin"
cp "$SRC" "$APP_DIR/resources/bin/amber"
chmod +x "$APP_DIR/resources/bin/amber"
# The router must sit BESIDE amber: `routerctl::sibling_binary` looks for it
# there, and `amber ctl router enable` refuses to write a unit without it.
cp "$ROUTER_SRC" "$APP_DIR/resources/bin/amber-router"
chmod +x "$APP_DIR/resources/bin/amber-router"
if [ "${DAEMON_SRC:-}" ]; then
    cp "$SRC" "$APP_DIR/resources/bin/amber.exe"
    cp "$DAEMON_SRC" "$APP_DIR/resources/bin/amberd.exe"
    cp "$ROUTER_SRC" "$APP_DIR/resources/bin/amber-router.exe"
    chmod +x "$APP_DIR/resources/bin/amber.exe" "$APP_DIR/resources/bin/amberd.exe" \
        "$APP_DIR/resources/bin/amber-router.exe"
fi

echo "==> building renderer/main/preload"
( cd "$APP_DIR" && npm run build && npm run build:web )

echo "==> packaging with electron-builder"
( cd "$APP_DIR" && npx electron-builder )

echo "==> artifacts:"
ls -la "$APP_DIR/release" 2>/dev/null || true

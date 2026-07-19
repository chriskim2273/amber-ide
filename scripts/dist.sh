#!/usr/bin/env bash
# Build distributable amber binaries. Linux → fully static (musl, zero deps).
# macOS → universal (x86_64 + arm64) via lipo. Windows → x86_64-pc-windows-msvc
# amber.exe. Run each on its own OS (or use a cross toolchain). Artifacts land
# in dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
mkdir -p "$OUT"

build_linux() {
    local target=x86_64-unknown-linux-musl
    rustup target add "$target"
    cargo build --release --target "$target" --bin amber
    cp "$ROOT/target/$target/release/amber" "$OUT/amber-linux-x86_64"
    echo "dist: $OUT/amber-linux-x86_64 (static)"
    # aarch64 static: needs the musl-cross linker; uncomment when set up.
    # rustup target add aarch64-unknown-linux-musl
    # cargo build --release --target aarch64-unknown-linux-musl --bin amber
}

build_macos() {
    rustup target add x86_64-apple-darwin aarch64-apple-darwin
    cargo build --release --target x86_64-apple-darwin --bin amber
    cargo build --release --target aarch64-apple-darwin --bin amber
    lipo -create -output "$OUT/amber-macos-universal" \
        "$ROOT/target/x86_64-apple-darwin/release/amber" \
        "$ROOT/target/aarch64-apple-darwin/release/amber"
    echo "dist: $OUT/amber-macos-universal (universal)"
}

# Intel-only macOS build (x86_64). Use on an Intel Mac when a universal binary
# is not needed — avoids requiring the aarch64-apple-darwin target.
build_macos_intel() {
    rustup target add x86_64-apple-darwin
    cargo build --release --target x86_64-apple-darwin --bin amber
    cp "$ROOT/target/x86_64-apple-darwin/release/amber" "$OUT/amber-x86_64-apple-darwin"
    echo "dist: $OUT/amber-x86_64-apple-darwin (intel)"
}

# Windows: native msvc build. `amber.exe` is the windows-subsystem daemon +
# console CLI. Run from a Git-Bash/MSYS shell on a Windows host with the MSVC
# toolchain installed.
build_windows() {
    local target=x86_64-pc-windows-msvc
    rustup target add "$target"
    cargo build --release --target "$target" --bin amber
    cp "$ROOT/target/$target/release/amber.exe" "$OUT/amber-windows-x86_64.exe"
    echo "dist: $OUT/amber-windows-x86_64.exe"
}

case "$(uname -s)" in
    Linux)  build_linux ;;
    Darwin)
        if [ "${AMBER_MACOS_INTEL:-0}" = "1" ]; then
            build_macos_intel
        else
            build_macos
        fi
        ;;
    MINGW*|MSYS*|CYGWIN*) build_windows ;;
    *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac

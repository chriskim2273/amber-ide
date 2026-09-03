#!/usr/bin/env bash
# Build distributable amber binaries. Linux → fully static (musl, zero deps).
# macOS → universal (x86_64 + arm64) via lipo. Run each on its own OS (or use a
# cross toolchain). Artifacts land in dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${AMBER_DIST_DIR:-$ROOT/dist}"
if [[ "$OUT" != /* ]]; then
    OUT="$ROOT/$OUT"
fi
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
if [[ "$TARGET_DIR" != /* ]]; then
    TARGET_DIR="$ROOT/$TARGET_DIR"
fi
export CARGO_TARGET_DIR="$TARGET_DIR"
mkdir -p "$OUT"

build_linux() {
    local target=x86_64-unknown-linux-musl
    rustup target add "$target"
    cargo build --release --target "$target" --bin amber --bin amber-router
    cp "$TARGET_DIR/$target/release/amber" "$OUT/amber-linux-x86_64"
    cp "$TARGET_DIR/$target/release/amber-router" "$OUT/amber-router-linux-x86_64"
    echo "dist: $OUT/amber-linux-x86_64 (static)"
    echo "dist: $OUT/amber-router-linux-x86_64 (static)"
    # aarch64 static: needs the musl-cross linker; uncomment when set up.
    # rustup target add aarch64-unknown-linux-musl
    # cargo build --release --target aarch64-unknown-linux-musl --bin amber
}

build_macos() {
    rustup target add x86_64-apple-darwin aarch64-apple-darwin
    for bin in amber amber-router; do
        cargo build --release --target x86_64-apple-darwin --bin "$bin"
        cargo build --release --target aarch64-apple-darwin --bin "$bin"
        lipo -create -output "$OUT/$bin-macos-universal" \
            "$TARGET_DIR/x86_64-apple-darwin/release/$bin" \
            "$TARGET_DIR/aarch64-apple-darwin/release/$bin"
        echo "dist: $OUT/$bin-macos-universal (universal)"
    done
}

# Intel-only macOS build (x86_64). Use on an Intel Mac when a universal binary
# is not needed — avoids requiring the aarch64-apple-darwin target.
build_macos_intel() {
    rustup target add x86_64-apple-darwin
    for bin in amber amber-router; do
        cargo build --release --target x86_64-apple-darwin --bin "$bin"
        cp "$TARGET_DIR/x86_64-apple-darwin/release/$bin" "$OUT/$bin-x86_64-apple-darwin"
        echo "dist: $OUT/$bin-x86_64-apple-darwin (intel)"
    done
}

build_windows() {
    local target=x86_64-pc-windows-msvc
    rustup target add "$target"
    cargo build --release --target "$target" --bin amber --bin amberd --bin amber-router
    cp "$TARGET_DIR/$target/release/amber.exe" "$OUT/amber-windows-x86_64.exe"
    cp "$TARGET_DIR/$target/release/amberd.exe" "$OUT/amberd-windows-x86_64.exe"
    cp "$TARGET_DIR/$target/release/amber-router.exe" "$OUT/amber-router-windows-x86_64.exe"
    echo "dist: $OUT/amber-router-windows-x86_64.exe (local proxy)"
    echo "dist: $OUT/amber-windows-x86_64.exe (console CLI)"
    echo "dist: $OUT/amberd-windows-x86_64.exe (windowless daemon)"
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

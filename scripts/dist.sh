#!/usr/bin/env bash
# Build distributable amber binaries. Linux → fully static (musl, zero deps).
# macOS → universal (x86_64 + arm64) via lipo. Run each on its own OS (or use a
# cross toolchain). Artifacts land in dist/.
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

case "$(uname -s)" in
    Linux)  build_linux ;;
    Darwin) build_macos ;;
    *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac

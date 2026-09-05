#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/repo/scripts"
cp "$ROOT/scripts/dist.sh" "$TMP/repo/scripts/dist.sh"

cat >"$TMP/bin/rustup" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$TMP/bin/cargo" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_CARGO_LOG"
target=''
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == --target ]]; then
    j=$((i + 1)); target="${!j}"
  fi
done
[[ -n "$target" ]]
out="${CARGO_TARGET_DIR:?}/$target/release"
mkdir -p "$out"
touch "$out/amber" "$out/amber-router"
EOF
chmod +x "$TMP/bin/rustup" "$TMP/bin/cargo"

FAKE_CARGO_LOG="$TMP/cargo.log" PATH="$TMP/bin:$PATH" \
  CARGO_TARGET_DIR="cargo-target" AMBER_DIST_DIR="dist" \
  bash "$TMP/repo/scripts/dist.sh" >/dev/null

[[ -f "$TMP/repo/dist/amber-linux-x86_64" ]]
[[ -f "$TMP/repo/dist/amber-router-linux-x86_64" ]]
grep -q -- '--bin amber-router' "$TMP/cargo.log"

echo 'dist: PASS'

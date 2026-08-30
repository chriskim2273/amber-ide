#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP/app.AppImage"
chmod +x "$TMP/app.AppImage"

cat >"$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
cat <<'ENV'
DISPLAY=:9
XAUTHORITY=/tmp/xauth
DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/bus
XDG_RUNTIME_DIR=/tmp/runtime
XMODIFIERS=@im=ibus
QT_IM_MODULE=ibus
ENV
EOF

cat >"$TMP/bin/ibus" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == address ]]; then
  if [[ -n "${IBUS_ADDRESS:-}" ]]; then echo "$IBUS_ADDRESS"; exit 0; fi
  if [[ -f "$FAKE_STATE/restarted" ]]; then
    echo 'unix:abstract=amber-test,guid=a'
  else
    echo 'unix:path=/missing/amber-test,guid=a'
  fi
elif [[ "$1" == restart && "$2" == --type=systemd ]]; then
  touch "$FAKE_STATE/restarted"
else
  exit 2
fi
EOF
chmod +x "$TMP/bin/systemctl" "$TMP/bin/ibus"

output="$(PATH="$TMP/bin:$PATH" HOME="$TMP/home" FAKE_STATE="$TMP" \
  IBUS_ADDRESS='unix:path=/also/missing,guid=stale' AMBER_RELAUNCH_DRY_RUN=1 \
  bash "$ROOT/scripts/relaunch-app-linux.sh" "$TMP/app.AppImage")"
[[ -f "$TMP/restarted" ]]
[[ "$output" == *'stale IBus address'* ]]
[[ "$output" == *'desktop input preflight passed'* ]]

# A healthy abstract address must not restart IBus.
rm -f "$TMP/restarted"
cat >"$TMP/bin/ibus" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == address ]]; then echo 'unix:abstract=already-live,guid=a'; exit 0; fi
if [[ "$1" == restart ]]; then exit 99; fi
exit 2
EOF
chmod +x "$TMP/bin/ibus"
output="$(PATH="$TMP/bin:$PATH" HOME="$TMP/home" FAKE_STATE="$TMP" AMBER_RELAUNCH_DRY_RUN=1 \
  bash "$ROOT/scripts/relaunch-app-linux.sh" "$TMP/app.AppImage")"
[[ "$output" == *'desktop input preflight passed'* ]]
[[ "$output" != *'stale IBus address'* ]]

echo 'relaunch-app-linux: PASS'

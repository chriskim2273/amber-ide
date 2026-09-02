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

# A running client must actually be stopped. The executable electron-builder
# produces is `amber-ide`; the stop-loop matched only `amber-ide-app`, so it
# found nothing, launched a replacement that lost Electron's single-instance
# race, and reported success while the OLD client kept running (2026-09-01).
# Both names must be recognised.
for exe_name in amber-ide amber-ide-app; do
  rm -rf "$TMP/fakeapp"
  mkdir -p "$TMP/fakeapp"
  # A REAL binary, not a #!-script: a script's /proc cmdline starts with the
  # interpreter, so argv[0] would be `bash` and the test would pass against a
  # broken script for the wrong reason.
  cp "$(command -v sleep)" "$TMP/fakeapp/$exe_name"
  "$TMP/fakeapp/$exe_name" 30 & victim=$!
  # Wait for /proc to show the real argv (exec has to have happened).
  for _ in $(seq 1 50); do
    [[ -r "/proc/$victim/cmdline" ]] && grep -qa "$exe_name" "/proc/$victim/cmdline" && break
    sleep 0.05
  done

  PATH="$TMP/bin:$PATH" HOME="$TMP/home" FAKE_STATE="$TMP" \
    bash "$ROOT/scripts/relaunch-app-linux.sh" "$TMP/app.AppImage" >/dev/null

  # The script TERMs it and waits; it must be gone.
  gone=false
  for _ in $(seq 1 50); do
    kill -0 "$victim" 2>/dev/null || { gone=true; break; }
    sleep 0.05
  done
  if [[ "$gone" != true ]]; then
    kill -9 "$victim" 2>/dev/null || true
    echo "relaunch-app-linux: FAIL — a running '$exe_name' was not stopped" >&2
    exit 1
  fi
  wait "$victim" 2>/dev/null || true
done

echo 'relaunch-app-linux: PASS'

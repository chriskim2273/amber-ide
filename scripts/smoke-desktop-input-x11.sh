#!/usr/bin/env bash
# End-to-end Linux desktop input proof. It launches a private daemon/session and
# an isolated AppImage window on the REAL X display, sends one key through XTest
# (not CDP), observes xterm through CDP, erases the key, and removes everything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPIMAGE_PATH="${1:-$HOME/Applications/amber-ide.AppImage}"
AMBER_BIN="${AMBER_BIN:-$HOME/.local/bin/amber}"
TMP="$(mktemp -d)"
APP_PID=''
DAEMON_PID=''
cleanup() {
  [[ -z "$APP_PID" ]] || kill -TERM "$APP_PID" 2>/dev/null || true
  [[ -z "$DAEMON_PID" ]] || kill -TERM "$DAEMON_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

for tool in systemctl xwininfo cc node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: required tool missing: $tool" >&2; exit 2; }
done
[[ -x "$APPIMAGE_PATH" ]] || { echo "error: AppImage is not executable: $APPIMAGE_PATH" >&2; exit 2; }
[[ -x "$AMBER_BIN" ]] || { echo "error: amber binary is not executable: $AMBER_BIN" >&2; exit 2; }

while IFS='=' read -r key value; do
  case "$key" in
    DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XMODIFIERS|GTK_IM_MODULE|QT_IM_MODULE)
      printf -v "$key" '%s' "$value"; export "$key" ;;
  esac
done < <(systemctl --user show-environment)
[[ -n "${DISPLAY:-}" ]] || { echo 'error: no graphical X display in the user environment' >&2; exit 2; }

# Reuse the production preflight before constructing the proof window.
AMBER_RELAUNCH_DRY_RUN=1 "$ROOT/scripts/relaunch-app-linux.sh" "$APPIMAGE_PATH"
cc "$ROOT/scripts/x11-send-key.c" -o "$TMP/x11-send-key" -lX11 -lXtst

SOCKET="$TMP/amber.sock"
mkdir -p "$TMP/daemon-state" "$TMP/ui-state"
"$AMBER_BIN" daemon --root "$TMP/daemon-state" --socket "$SOCKET" >"$TMP/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 100); do [[ -S "$SOCKET" ]] && break; sleep 0.05; done
[[ -S "$SOCKET" ]] || { cat "$TMP/daemon.log" >&2; echo 'error: private daemon did not start' >&2; exit 1; }
"$AMBER_BIN" create --socket "$SOCKET" --cwd "$TMP" amber-1-1-0-inputsmoke >/dev/null

PORT="$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()
PY
)"
mapfile -t BEFORE < <(DISPLAY="$DISPLAY" xwininfo -root -tree 2>/dev/null \
  | awk '/"Amber ·.*\("amber-ide-app"/{print $1}' | sort -u)

HOME="$HOME" XDG_STATE_HOME="$TMP/ui-state" AMBER_SOCKET="$SOCKET" \
AMBER_NO_SANDBOX=1 AMBER_SOFTWARE_GL=1 \
"$APPIMAGE_PATH" --remote-debugging-port="$PORT" --user-data-dir="$TMP/chrome" >"$TMP/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 200); do curl -fsS "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break; sleep 0.1; done
curl -fsS "http://127.0.0.1:$PORT/json" >/dev/null || { cat "$TMP/app.log" >&2; echo 'error: diagnostic renderer did not start' >&2; exit 1; }

XID=''
for _ in $(seq 1 100); do
  mapfile -t AFTER < <(DISPLAY="$DISPLAY" xwininfo -root -tree 2>/dev/null \
    | awk '/"Amber ·.*\("amber-ide-app"/{print $1}' | sort -u)
  for candidate in "${AFTER[@]}"; do
    seen=false
    for old in "${BEFORE[@]}"; do [[ "$candidate" == "$old" ]] && seen=true; done
    if [[ "$seen" == false ]]; then XID="$candidate"; break; fi
  done
  [[ -n "$XID" ]] && break
  sleep 0.1
done
[[ -n "$XID" ]] || { cat "$TMP/app.log" >&2; echo 'error: isolated Amber X window not found' >&2; exit 1; }

info="$(DISPLAY="$DISPLAY" xwininfo -id "$XID")"
OFFSET_X="$(awk '/Absolute upper-left X:/{print $4}' <<<"$info")"
OFFSET_Y="$(awk '/Absolute upper-left Y:/{print $4}' <<<"$info")"
node "$ROOT/scripts/cdp-x11-input-smoke.mjs" \
  "$PORT" "$DISPLAY" "$XID" "$OFFSET_X" "$OFFSET_Y" "$TMP/x11-send-key"

#!/usr/bin/env bash
# Safely relaunch the installed Amber AppImage inside the current Linux desktop
# session. This is the supported post-deploy path: it imports the graphical
# environment, repairs a stale IBus socket before Electron starts, and never
# touches the amber daemon or its PTYs.
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "error: relaunch-app-linux.sh is Linux-only" >&2
  exit 2
fi

APPIMAGE_PATH="${1:-$HOME/Applications/amber-ide.AppImage}"
if [[ ! -x "$APPIMAGE_PATH" ]]; then
  echo "error: AppImage is not executable: $APPIMAGE_PATH" >&2
  exit 2
fi

# A non-interactive deploy shell often lacks GNOME's input/display variables.
# Import only the narrow allowlist the GUI needs; never eval manager output.
while IFS='=' read -r key value; do
  case "$key" in
    DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XMODIFIERS|GTK_IM_MODULE|QT_IM_MODULE)
      printf -v "$key" '%s' "$value"
      export "$key"
      ;;
  esac
done < <(systemctl --user show-environment)

# GNOME's systemd-managed registry is authoritative. A stale inherited override
# would otherwise survive the restart and keep every new process broken.
unset IBUS_ADDRESS

ibus_selected=false
for value in "${XMODIFIERS:-}" "${GTK_IM_MODULE:-}" "${QT_IM_MODULE:-}"; do
  if [[ "${value,,}" == *ibus* ]]; then ibus_selected=true; break; fi
done

ibus_address_healthy() {
  local address path
  address="$(DISPLAY="${DISPLAY:-}" ibus address 2>/dev/null || true)"
  [[ -n "$address" && "$address" != '(null)' ]] || return 1
  if [[ "$address" =~ (^|\;)unix:path=([^,\;]+) ]]; then
    path="${BASH_REMATCH[2]}"
    [[ -S "$path" ]]
    return
  fi
  [[ "$address" =~ (^|\;)unix:abstract=([^,\;]+) ]]
}

if [[ "$ibus_selected" == true && -n "${DISPLAY:-}" ]]; then
  if ! command -v ibus >/dev/null 2>&1; then
    echo "error: IBus is selected but the 'ibus' command is unavailable" >&2
    exit 1
  fi
  if ! ibus_address_healthy; then
    echo "==> stale IBus address; restarting through the GNOME systemd service"
    ibus restart --type=systemd
    healthy=false
    for _ in $(seq 1 30); do
      if ibus_address_healthy; then healthy=true; break; fi
      sleep 0.1
    done
    if [[ "$healthy" != true ]]; then
      echo "error: IBus did not publish a live replacement socket" >&2
      exit 1
    fi
  fi
fi

echo "==> desktop input preflight passed"
if [[ "${AMBER_RELAUNCH_DRY_RUN:-0}" == 1 ]]; then exit 0; fi

# Stop only AppImage main processes. Chromium children include --type= and are
# reaped with their parent; dev Electron binaries are named `electron` and are
# deliberately untouched.
#
# The packaged executable is `amber-ide` (electron-builder's default from the
# package name); `amber-ide-app` is kept for older packages. Matching the wrong
# name is not a loud failure — the loop simply finds nothing, the replacement
# loses Electron's single-instance race, and the OLD client keeps running while
# this script reports success. That is exactly what happened on 2026-09-01.
is_amber_main() {
  local base="${1##*/}"
  [[ "$base" == amber-ide || "$base" == amber-ide-app ]]
}

for cmdline in /proc/[0-9]*/cmdline; do
  [[ -r "$cmdline" ]] || continue
  mapfile -d '' -t argv < "$cmdline" || true
  [[ ${#argv[@]} -gt 0 ]] && is_amber_main "${argv[0]}" || continue
  child=false
  for arg in "${argv[@]:1}"; do
    if [[ "$arg" == --type=* ]]; then child=true; break; fi
  done
  [[ "$child" == false ]] || continue
  pid="${cmdline#/proc/}"; pid="${pid%/cmdline}"
  kill -TERM "$pid" 2>/dev/null || true
done

for _ in $(seq 1 100); do
  alive=false
  for cmdline in /proc/[0-9]*/cmdline; do
    [[ -r "$cmdline" ]] || continue
    mapfile -d '' -t argv < "$cmdline" || true
    [[ ${#argv[@]} -gt 0 ]] && is_amber_main "${argv[0]}" || continue
    child=false
    for arg in "${argv[@]:1}"; do [[ "$arg" == --type=* ]] && child=true; done
    [[ "$child" == true ]] || alive=true
  done
  [[ "$alive" == false ]] && break
  sleep 0.1
done
if [[ "$alive" == true ]]; then
  echo 'error: the existing Amber client did not exit; refusing to launch the replacement' >&2
  exit 1
fi

state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
mkdir -p "$state_home/amber-ide"
log="$state_home/amber-ide/app-launch.log"
nohup "$APPIMAGE_PATH" >>"$log" 2>&1 &
echo "==> launched $APPIMAGE_PATH (log: $log)"

#!/usr/bin/env bash
# Install the amber session daemon + its boot unit. Idempotent. Never touches a
# running daemon's sessions. Linux (systemd user unit) and macOS (launchd agent).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="${AMBER_BIN_DIR:-$HOME/.local/bin}"
AMBER_BIN="$BIN_DIR/amber"

log() { printf 'amber-install: %s\n' "$*"; }

# 1. Build the release binary and place it on PATH.
build_and_install_bin() {
    log "building release binary (cargo build --release)"
    (cd "$REPO_ROOT" && cargo build --release --bin amber)
    mkdir -p "$BIN_DIR"
    install -m 0755 "$REPO_ROOT/target/release/amber" "$AMBER_BIN"
    log "installed $AMBER_BIN"
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *) log "WARNING: $BIN_DIR is not on your PATH — add it to your shell profile" ;;
    esac
}

install_linux() {
    local unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    install -m 0644 "$REPO_ROOT/infra/daemon/amber.service" "$unit_dir/amber.service"
    # enable-linger so the daemon starts at boot, before login, and survives logout.
    loginctl enable-linger "$USER" 2>/dev/null || \
        log "note: could not enable-linger (needs a logind session); boot-start may require it"
    systemctl --user daemon-reload
    systemctl --user enable --now amber.service
    log "systemd user unit enabled and started"
    log "status: systemctl --user status amber.service"
}

install_macos() {
    local agent_dir="$HOME/Library/LaunchAgents"
    local plist="$agent_dir/com.amber-ide.daemon.plist"
    mkdir -p "$agent_dir"
    sed "s#__AMBER_BIN__#$AMBER_BIN#g" \
        "$REPO_ROOT/infra/daemon/com.amber-ide.daemon.plist.in" > "$plist"
    chmod 0644 "$plist"
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    log "launchd agent loaded ($plist)"
}

build_and_install_bin
case "$(uname -s)" in
    Linux)  install_linux ;;
    Darwin) install_macos ;;
    *) log "unsupported OS: $(uname -s) (Linux and macOS only)"; exit 1 ;;
esac
log "done. The daemon owns sessions on its unix socket; attach with 'amber attach <name>'."

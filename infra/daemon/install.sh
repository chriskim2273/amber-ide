#!/usr/bin/env bash
# Install / uninstall the amber session daemon + its boot unit. Idempotent.
# Never touches a running daemon's sessions (unless `uninstall --purge-state`).
# Linux (systemd user unit) and macOS (launchd agent).
#
# Usage:
#   install.sh [install] [--web]               build + install + enable boot unit
#                                              (--web also enables `amber web`,
#                                              the 127.0.0.1 mobile UI)
#   install.sh uninstall [--purge-binary] [--purge-state] [--web]
#                                              stop + disable + remove boot unit
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="${AMBER_BIN_DIR:-$HOME/.local/bin}"
AMBER_BIN="$BIN_DIR/amber"
# Mirror the daemon's default_root(): $XDG_STATE_HOME/amber-ide, else
# $HOME/.local/state/amber-ide.
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/amber-ide"

log() { printf 'amber-install: %s\n' "$*"; }

# --- install -----------------------------------------------------------------

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

# `amber web`: the 127.0.0.1 mobile UI. Opt-in (it opens a local port), and a
# plain daemon CLIENT — safe to start before/after the daemon (it reconnects).
install_web_linux() {
    local unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    install -m 0644 "$REPO_ROOT/infra/daemon/amber-web.service" "$unit_dir/amber-web.service"
    systemctl --user daemon-reload
    systemctl --user enable --now amber-web.service
    log "amber web enabled on 127.0.0.1:7717"
    log "phone URL: $AMBER_BIN web --print-url   (expose it: tailscale serve --bg 7717)"
}

install_web_macos() {
    local plist="$HOME/Library/LaunchAgents/com.amber-ide.web.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    sed "s#__AMBER_BIN__#$AMBER_BIN#g" \
        "$REPO_ROOT/infra/daemon/com.amber-ide.web.plist.in" > "$plist"
    chmod 0644 "$plist"
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    log "amber web agent loaded ($plist), 127.0.0.1:7717"
    log "phone URL: $AMBER_BIN web --print-url   (expose it: tailscale serve --bg 7717)"
}

do_install() {
    local with_web=false
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --web) with_web=true ;;
            *) log "unknown install option: $1"; exit 1 ;;
        esac
        shift
    done

    build_and_install_bin
    case "$(uname -s)" in
        # `if` not `&&`: a false test as the last command of a case branch
        # would exit the script under `set -e`.
        Linux)  install_linux;  if [ "$with_web" = true ]; then install_web_linux; fi ;;
        Darwin) install_macos;  if [ "$with_web" = true ]; then install_web_macos; fi ;;
        *) log "unsupported OS: $(uname -s) (Linux and macOS only)"; exit 1 ;;
    esac
    log "done. The daemon owns sessions on its unix socket; attach with 'amber attach <name>'."
}

# --- uninstall (mirror of install; idempotent) -------------------------------

uninstall_linux() {
    local unit="$HOME/.config/systemd/user/amber.service"
    # Stop + disable are best-effort: neither must fail a re-run under `set -e`.
    systemctl --user stop amber.service 2>/dev/null || true
    systemctl --user disable amber.service 2>/dev/null || true
    if [ -f "$unit" ]; then
        rm -f "$unit"
        log "removed $unit"
    else
        log "no systemd unit at $unit (already removed)"
    fi
    systemctl --user daemon-reload 2>/dev/null || true
}

uninstall_macos() {
    local plist="$HOME/Library/LaunchAgents/com.amber-ide.daemon.plist"
    launchctl unload "$plist" 2>/dev/null || true
    if [ -f "$plist" ]; then
        rm -f "$plist"
        log "removed $plist"
    else
        log "no launchd agent at $plist (already removed)"
    fi
}

uninstall_web_linux() {
    local unit="$HOME/.config/systemd/user/amber-web.service"
    systemctl --user stop amber-web.service 2>/dev/null || true
    systemctl --user disable amber-web.service 2>/dev/null || true
    rm -f "$unit"
    systemctl --user daemon-reload 2>/dev/null || true
    log "removed amber web unit"
}

uninstall_web_macos() {
    local plist="$HOME/Library/LaunchAgents/com.amber-ide.web.plist"
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    log "removed amber web agent"
}

do_uninstall() {
    local purge_binary=false purge_state=false with_web=false
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --purge-binary) purge_binary=true ;;
            --purge-state)  purge_state=true ;;
            --web)          with_web=true ;;
            *) log "unknown uninstall option: $1"; exit 1 ;;
        esac
        shift
    done

    case "$(uname -s)" in
        Linux)  uninstall_linux;  if [ "$with_web" = true ]; then uninstall_web_linux; fi ;;
        Darwin) uninstall_macos;  if [ "$with_web" = true ]; then uninstall_web_macos; fi ;;
        *) log "unsupported OS: $(uname -s) (Linux and macOS only)"; exit 1 ;;
    esac

    if [ "$purge_binary" = true ]; then
        if [ -f "$AMBER_BIN" ]; then
            rm -f "$AMBER_BIN"
            log "removed $AMBER_BIN"
        else
            log "no binary at $AMBER_BIN (already removed)"
        fi
    else
        log "kept binary $AMBER_BIN (pass --purge-binary to remove it)"
    fi

    if [ "$purge_state" = true ]; then
        if [ -d "$STATE_DIR" ]; then
            rm -rf "$STATE_DIR"
            log "removed state store $STATE_DIR"
        else
            log "no state store at $STATE_DIR (already removed)"
        fi
    else
        log "kept state store $STATE_DIR (pass --purge-state to remove it)"
    fi

    log "done. Boot unit removed; the daemon will not start at boot."
}

# --- dispatch ----------------------------------------------------------------
# Default (no arg) is install, so `bash install.sh` and the existing ctl-install
# wiring keep working unchanged.
case "${1:-install}" in
    install)   shift || true; do_install "$@" ;;
    uninstall) shift; do_uninstall "$@" ;;
    --web)     do_install --web ;;
    *) log "unknown subcommand: $1 (expected 'install' or 'uninstall')"; exit 1 ;;
esac

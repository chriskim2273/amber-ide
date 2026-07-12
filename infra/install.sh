#!/usr/bin/env bash
# amber-ide Phase 1 installer: tmux persistence spine (macOS + Linux).
#
# Idempotent. Never kills or restarts a running tmux server — existing
# sessions are untouched; the new config is loaded into a live server with
# `tmux source-file` at the end.
set -euo pipefail

RESURRECT_REPO="https://github.com/tmux-plugins/tmux-resurrect"
CONTINUUM_REPO="https://github.com/tmux-plugins/tmux-continuum"
# Pinned commits (see infra/README.md). Update deliberately, not implicitly.
RESURRECT_PIN="cff343cf9e81983d3da0c8562b01616f12e8d548"
CONTINUUM_PIN="0698e8f4b17d6454c71bf5212895ec055c578da0"

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/amber-ide/plugins"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tmux"
CONF_TARGET="$CONF_DIR/tmux.conf"

info() { printf '\033[1;34m[amber-ide]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[amber-ide]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[amber-ide]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Preconditions -------------------------------------------------------
command -v tmux >/dev/null || die "tmux not found. Install tmux >= 3.2 first."
command -v git  >/dev/null || die "git not found."

tmux_ver="$(tmux -V | awk '{print $2}' | sed 's/[a-zA-Z]*$//')"
if [ "$(printf '%s\n' 3.2 "$tmux_ver" | sort -V | head -1)" != "3.2" ]; then
  die "tmux $tmux_ver found, but >= 3.2 is required."
fi
info "tmux $tmux_ver OK (>= 3.2)"

if [ -f "$HOME/.tmux.conf" ]; then
  warn "~/.tmux.conf exists and takes precedence over $CONF_TARGET."
  warn "Merge it into $CONF_TARGET or remove it, then re-run. Aborting."
  exit 1
fi

# --- 2. Vendored plugins (pinned clones) -------------------------------------
clone_pinned() { # repo dir pin
  local repo="$1" dir="$2" pin="$3"
  if [ ! -d "$dir/.git" ]; then
    info "Cloning $repo"
    git clone --quiet "$repo" "$dir"
  fi
  git -C "$dir" fetch --quiet origin
  git -C "$dir" checkout --quiet --detach "$pin"
  info "$(basename "$dir") pinned at $(git -C "$dir" rev-parse --short HEAD)"
}
mkdir -p "$PLUGIN_DIR"
clone_pinned "$RESURRECT_REPO" "$PLUGIN_DIR/tmux-resurrect" "$RESURRECT_PIN"
clone_pinned "$CONTINUUM_REPO" "$PLUGIN_DIR/tmux-continuum" "$CONTINUUM_PIN"

# --- 3. tmux.conf -------------------------------------------------------------
mkdir -p "$CONF_DIR"
if [ -f "$CONF_TARGET" ] && ! cmp -s "$INFRA_DIR/tmux.conf" "$CONF_TARGET"; then
  backup="$CONF_TARGET.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CONF_TARGET" "$backup"
  warn "Existing $CONF_TARGET backed up to $backup"
fi
cp "$INFRA_DIR/tmux.conf" "$CONF_TARGET"
info "Installed $CONF_TARGET"

# --- 4. Boot autostart --------------------------------------------------------
case "$(uname -s)" in
  Linux)
    unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$unit_dir"
    cp "$INFRA_DIR/systemd/amber-tmux.service" "$unit_dir/"
    systemctl --user daemon-reload
    systemctl --user enable amber-tmux.service
    # Lingering starts the user manager (and thus the tmux server) at boot,
    # before login, and keeps it alive across logouts.
    loginctl enable-linger "$USER" || warn "enable-linger failed; server will start at login instead of boot."
    info "systemd user unit enabled (amber-tmux.service)"
    ;;
  Darwin)
    agent_dir="$HOME/Library/LaunchAgents"
    mkdir -p "$agent_dir"
    cp "$INFRA_DIR/launchd/com.amber-ide.tmux.plist" "$agent_dir/"
    launchctl unload "$agent_dir/com.amber-ide.tmux.plist" 2>/dev/null || true
    launchctl load "$agent_dir/com.amber-ide.tmux.plist"
    info "launchd agent loaded (com.amber-ide.tmux)"
    ;;
  *) die "Unsupported OS: $(uname -s) (macOS and Linux only)." ;;
esac

# --- 5. Live server ------------------------------------------------------------
if tmux has-session 2>/dev/null; then
  tmux source-file "$CONF_TARGET"
  info "Running tmux server detected: config sourced in place, sessions untouched."
  info "Continuum's autosave timer is now active in the running server."
else
  tmux new-session -d -s _amber-boot
  info "Started tmux server with bootstrap session '_amber-boot'."
fi

info "Done. Torture test procedure: infra/README.md"

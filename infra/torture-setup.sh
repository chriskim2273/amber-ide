#!/usr/bin/env bash
# Build the Phase 1 torture-test layout: 4 sessions, each exactly ONE window
# with ONE pane (matching the one-session-per-terminal-pane workflow), every
# pane in a distinct cwd. Claude panes are started manually afterwards (the
# test needs real conversation history) — see infra/README.md.
#
# The pane directories MUST survive a reboot: resurrect restores each pane's
# cwd with `-c <dir>`, and if the directory is gone tmux silently falls back
# to $HOME (which also breaks `claude --continue`, since that resumes the most
# recent conversation of whatever directory the pane lands in). /tmp is wiped
# at boot, so the dirs live under ~/.local/share instead.
set -euo pipefail

sessions="torture-a torture-b torture-c torture-d"
for s in $sessions; do
  if tmux has-session -t "=$s" 2>/dev/null; then
    echo "Session $s already exists — kill it first: tmux kill-session -t $s" >&2
    exit 1
  fi
done

base="${XDG_DATA_HOME:-$HOME/.local/share}/amber-ide/torture"

i=0
for s in $sessions; do
  i=$((i+1))
  dir="$base/$s"
  mkdir -p "$dir"
  tmux new-session -d -s "$s" -n main -c "$dir"
  # Distinct scrollback marker so restored pane contents are verifiable.
  tmux send-keys -t "$s:main" "echo TORTURE-MARKER-$i; pwd" Enter
done

echo "Layout ready:"
tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}  #{pane_current_path}' | grep torture
echo
echo "Next: start 'claude' in TWO of the sessions above, as-is — each is"
echo "already in its own distinct directory. Do NOT cd into a real project"
echo "directory you also use Claude in: 'claude --continue' resumes the most"
echo "recent conversation per directory, so a busy directory resumes the"
echo "wrong conversation. Hold a short conversation in each, then follow"
echo "infra/README.md."

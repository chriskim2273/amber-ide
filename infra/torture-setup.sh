#!/usr/bin/env bash
# Build the Phase 1 torture-test layout: 3 sessions, each with a SINGLE
# window (matching the one-window-per-session workflow), 6 panes total,
# every pane in a distinct cwd. Claude panes are started manually afterwards
# (the test needs real conversation history) — see infra/README.md.
#
# The pane directories MUST survive a reboot: resurrect restores each pane's
# cwd with `-c <dir>`, and if the directory is gone tmux silently falls back
# to $HOME (which also breaks `claude --continue`, since that resumes the most
# recent conversation of whatever directory the pane lands in). /tmp is wiped
# at boot, so the dirs live under ~/.local/share instead.
set -euo pipefail

for s in torture-a torture-b torture-c; do
  if tmux has-session -t "=$s" 2>/dev/null; then
    echo "Session $s already exists — kill it first: tmux kill-session -t $s" >&2
    exit 1
  fi
done

base="${XDG_DATA_HOME:-$HOME/.local/share}/amber-ide/torture"
d1=$base/one d2=$base/two d3=$base/three d4=$base/four d5=$base/five d6=$base/six
mkdir -p "$d1" "$d2" "$d3" "$d4" "$d5" "$d6"

# torture-a: single window "edit", 3 panes
tmux new-session  -d -s torture-a -n edit -c "$d1"
tmux split-window -h -t torture-a:edit    -c "$d2"
tmux split-window -v -t torture-a:edit    -c "$d3"

# torture-b: single window "misc", 2 panes
tmux new-session  -d -s torture-b -n misc -c "$d4"
tmux split-window -v -t torture-b:misc    -c "$d5"

# torture-c: single window "solo", 1 pane (natural spot for a claude)
tmux new-session  -d -s torture-c -n solo -c "$d6"

# Distinct scrollback markers so restored pane contents are verifiable.
i=0
for pane in $(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' | grep torture); do
  i=$((i+1))
  tmux send-keys -t "$pane" "echo TORTURE-MARKER-$i; pwd" Enter
done

echo "Layout ready:"
tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}  #{pane_current_path}' | grep torture
echo
echo "Next: start 'claude' in TWO of the panes above, as-is — they are already"
echo "in distinct directories (torture-c is a natural pick for one of them)."
echo "Do NOT cd into a real project directory you also use Claude in:"
echo "'claude --continue' resumes the most recent conversation per directory,"
echo "so a busy directory resumes the wrong conversation."
echo "Hold a short conversation in each, then follow infra/README.md."

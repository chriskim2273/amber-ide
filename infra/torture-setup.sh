#!/usr/bin/env bash
# Build the Phase 1 torture-test layout: 2 sessions / 3 windows / 5 panes,
# every pane in a distinct cwd. Claude panes are started manually afterwards
# (the test needs real conversation history) — see infra/README.md.
set -euo pipefail

for s in torture-a torture-b; do
  if tmux has-session -t "=$s" 2>/dev/null; then
    echo "Session $s already exists — kill it first: tmux kill-session -t $s" >&2
    exit 1
  fi
done

d1=/tmp/torture/one d2=/tmp/torture/two d3=/tmp/torture/three d4=/tmp/torture/four d5=/tmp/torture/five
mkdir -p "$d1" "$d2" "$d3" "$d4" "$d5"

# torture-a: window "edit" (3 panes), window "build" (1 pane)
tmux new-session  -d -s torture-a -n edit  -c "$d1"
tmux split-window -h -t torture-a:edit     -c "$d2"
tmux split-window -v -t torture-a:edit     -c "$d3"
tmux new-window      -t torture-a -n build -c "$d4"

# torture-b: window "misc" (2 panes)
tmux new-session  -d -s torture-b -n misc  -c "$d5"
tmux split-window -v -t torture-b:misc     -c "$HOME"

# Distinct scrollback markers so restored pane contents are verifiable.
i=0
for pane in $(tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{session_name}' | awk '/torture/{print $1}'); do
  i=$((i+1))
  tmux send-keys -t "$pane" "echo TORTURE-MARKER-$i; pwd" Enter
done

echo "Layout ready:"
tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}  #{pane_current_path}' | grep torture
echo
echo "Next: start 'claude' in two panes that are in DIFFERENT directories,"
echo "hold a short conversation in each, then follow infra/README.md."

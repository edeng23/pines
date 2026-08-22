#!/usr/bin/env bash
#
# Capture a running pines TUI as a PNG, for docs and posts.
#
#   tmux new-session -d -s pines -x 170 -y 30 'node scripts/demo.mjs --reset'
#   scripts/screenshot/shot.sh forest "pines — forest"
#
# Drive the TUI with `tmux send-keys -t pines …` between shots. The pane is
# captured with its escape sequences, rendered to a terminal-window HTML page
# by ansi2html.mjs, and screenshotted with headless Chromium at 2x.
#
# CHROMIUM overrides the browser binary; SESSION the tmux session name.
set -euo pipefail

name=$1
title=${2:-pines}
session=${SESSION:-pines}
chromium=${CHROMIUM:-/opt/pw-browsers/chromium}
here=$(cd "$(dirname "$0")" && pwd)
out=${OUT:-$(cd "$here/../../docs/shots" && pwd)}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tmux capture-pane -t "$session" -e -p > "$work/frame.ansi"
size=$(node "$here/ansi2html.mjs" --title "$title" \
  < "$work/frame.ansi" 2> "$work/size" > "$work/frame.html"; cat "$work/size")

mkdir -p "$out"
"$chromium" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=2 --default-background-color=06080bff \
  --window-size="${size/x/,}" \
  --screenshot="$out/$name.png" "file://$work/frame.html" 2>/dev/null

echo "wrote $out/$name.png"

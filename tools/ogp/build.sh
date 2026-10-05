#!/bin/sh
# Rebuild og.jpg (the 1200x630 Open Graph / Twitter card image) from the live game.
# Needs the game served on http://localhost:8765 (.claude/launch.json "game") and Google Chrome.
set -eu
cd "$(dirname "$0")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=8000 --screenshot="$1" "$2" 2>/dev/null; }
# a seeded bot run, fast-forwarded and frozen as it takes off at a cactus
shot frame.png "http://localhost:8765/?seed=7&bot=1&sim=8800&freeze=1&hi=812&lang=en"
shot card.png "file://$PWD/compose.html"
sips -s format jpeg -s formatOptions 88 card.png --out ../../og.jpg >/dev/null
rm -f frame.png card.png

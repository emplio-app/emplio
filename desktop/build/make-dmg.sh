#!/bin/sh
# Emplio.dmg from the packed app (npm run pack): the installer window with the app and the Applications shortcut.
# Needs dmgbuild once:  python3 -m venv ~/.emplio-dmg && ~/.emplio-dmg/bin/pip install dmgbuild
set -e
cd "$(dirname "$0")/.."
APP="out/Emplio-darwin-arm64/Emplio.app"
[ -d "$APP" ] || { echo "run npm run pack first" >&2; exit 1; }
DMGBUILD="${DMGBUILD:-$(command -v dmgbuild || echo "$HOME/.emplio-dmg/bin/dmgbuild")}"
VERSION=$(node -p "require('./package.json').version")
OUT="out/Emplio-$VERSION.dmg"
rm -f "$OUT"
"$DMGBUILD" -s build/dmg-settings.py -D app="$APP" -D settings="$PWD/build/dmg-settings.py" "Emplio" "$OUT"
echo "$OUT"

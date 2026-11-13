#!/bin/sh
# Emplio.dmg from a packed app (npm run pack, or pack:older for macOS 11 and 12): the installer window with the app and the
# Applications shortcut. Usage: make-dmg.sh APP [older]
# Signs app and dmg, notarizes the dmg (Apple's ticket covers the app inside it too, so one wait, not two) and staples
# both (build/sign-notarize.sh; SKIP_NOTARIZE=1 to sign only). Safe to run for both builds at once (desktop/package.json).
# Needs dmgbuild once:  python3 -m venv ~/.emplio-dmg && ~/.emplio-dmg/bin/pip install dmgbuild
set -e
cd "$(dirname "$0")/.."
APP="${1:?usage: make-dmg.sh APP [older]}"
[ -d "$APP" ] || { echo "run npm run pack first" >&2; exit 1; }
DMGBUILD="${DMGBUILD:-$(command -v dmgbuild || echo "$HOME/.emplio-dmg/bin/dmgbuild")}"
VERSION=$(node -p "require('./package.json').version")
OUT="out/Emplio-$VERSION${2:+-$2}.dmg"
# sign on the internal disk: an external drive keeps adding ._ files that break signing
WORK=$(mktemp -d "${TMPDIR:-/tmp}/emplio-dmg.XXXXXX")
ditto --norsrc --noextattr "$APP" "$WORK/Emplio.app"
find "$WORK/Emplio.app" -name "._*" -delete
APP="$WORK/Emplio.app"
SKIP_NOTARIZE=1 sh build/sign-notarize.sh app "$APP"
rm -f "$OUT"
# one at a time: both builds' images mount as a volume named Emplio
/usr/bin/lockf "${TMPDIR:-/tmp}/emplio-dmgbuild.lock" "$DMGBUILD" -s build/dmg-settings.py -D app="$APP" -D settings="$PWD/build/dmg-settings.py" "Emplio" "$OUT"
sh build/sign-notarize.sh dmg "$OUT"
[ "${SKIP_NOTARIZE:-}" = 1 ] || xcrun stapler staple "$APP"
# the signed app, zipped: what apps already installed update to (desktop/src/update.js)
rm -f "${OUT%.dmg}-mac.zip"
ditto -c -k --keepParent "$APP" "${OUT%.dmg}-mac.zip"
echo "$OUT"

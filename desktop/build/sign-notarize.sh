#!/bin/sh
# Sign (Developer ID, hardened runtime), notarize and staple. Usage: sign-notarize.sh app|dmg PATH
# Needs the identity in the login keychain and a notary profile: xcrun notarytool store-credentials emplio-notary
set -e
cd "$(dirname "$0")/.."
IDENTITY="${EMPLIO_SIGN_IDENTITY:-Developer ID Application: Kulp Labs Private Limited (3M6G6JK577)}"
PROFILE="${EMPLIO_NOTARY_PROFILE:-emplio-notary}"
KIND="$1"; TARGET="$2"
notarize() { xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait; }
case "$KIND" in
  app)
    # every helper, framework and the app itself; children get the inherit entitlements
    node --input-type=module -e '
      import { sign } from "@electron/osx-sign";
      const [app, identity] = process.argv.slice(1);
      const entitlements = "build/entitlements.plist";
      await sign({ app, identity, platform: "darwin", optionsForFile: () => ({ hardenedRuntime: true, entitlements }) });
    ' "$TARGET" "$IDENTITY"
    codesign --verify --deep --strict --verbose=2 "$TARGET"
    [ "${SKIP_NOTARIZE:-}" = 1 ] && exit 0
    ZIP="$(mktemp -d)/Emplio.zip"
    ditto -c -k --keepParent "$TARGET" "$ZIP"
    notarize "$ZIP"
    xcrun stapler staple "$TARGET"
    ;;
  dmg)
    codesign --force --sign "$IDENTITY" --timestamp "$TARGET"
    codesign --verify --strict --verbose=2 "$TARGET"
    [ "${SKIP_NOTARIZE:-}" = 1 ] && exit 0
    notarize "$TARGET"
    xcrun stapler staple "$TARGET"
    ;;
  *) echo "usage: $0 app|dmg PATH" >&2; exit 1 ;;
esac

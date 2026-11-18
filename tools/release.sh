#!/bin/bash
# Build, sign, notarize and publish a release that the in-app updater picks up:
#   tools/release.sh 0.3.7 "What changed"
# - macOS: one universal app (Apple silicon + Intel), signed, notarized, stapled.
# - Windows: built by the Build workflow on GitHub (started here, on the same commit), then its
#   installer is signed for the updater on this machine, so the updater key never leaves it.
#   SKIP_WINDOWS=1 releases macOS only.
# Needs: Developer ID cert in the keychain, `xcrun notarytool` profile "notary", the updater key
# at ~/.tauri/micro-speed-grader.key, rustup targets aarch64- and x86_64-apple-darwin, `gh` logged in.
set -euo pipefail
VER="${1:?version, e.g. 0.3.7}"
NOTES="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
B="$APP/src-tauri/target/universal-apple-darwin/release/bundle"
OUT="$(mktemp -d)"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Alexander Gadin (8644223FJ6)}"
KEY="${UPDATER_KEY:-$HOME/.tauri/micro-speed-grader.key}"
REPO=agadin/micro-speed-grader
DL="https://github.com/$REPO/releases/download/v$VER"

# what's released must be what's on GitHub (the release tags main there, and Windows builds from it)
git -C "$ROOT" fetch -q origin main
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse origin/main)" ] || { echo "push main first: HEAD isn't origin/main" >&2; exit 1; }
CONF_VER=$(python3 -c "import json;print(json.load(open('$APP/src-tauri/tauri.conf.json'))['version'])")
[ "$CONF_VER" = "$VER" ] || { echo "the version files say $CONF_VER; bump them to $VER and push first (see CLAUDE.md)" >&2; exit 1; }
SHA=$(git -C "$ROOT" rev-parse HEAD)

# Windows: start it now so it builds while macOS notarizes
if [ -z "${SKIP_WINDOWS:-}" ]; then
  gh workflow run build.yml -R "$REPO" --ref main -f version="$VER"
  RUN=""
  for _ in $(seq 1 30); do
    sleep 4
    RUN=$(gh run list -R "$REPO" --workflow build.yml --event workflow_dispatch --limit 5 --json databaseId,headSha \
      -q "map(select(.headSha == \"$SHA\"))[0].databaseId // empty")
    [ -n "$RUN" ] && break
  done
  [ -n "$RUN" ] || { echo "couldn't find the Windows build run" >&2; exit 1; }
  echo "Windows build: https://github.com/$REPO/actions/runs/$RUN"
fi

# macOS
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
"$ROOT/tools/fetch-openslide.sh" mac >/dev/null
(cd "$APP" && APPLE_SIGNING_IDENTITY="$IDENTITY" TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build -- --target universal-apple-darwin --bundles app,dmg)

# notarize + staple the app, then rebuild the updater archive from the stapled app
cd "$B/macos"
ditto -c -k --keepParent "Micro Speed Grader.app" "$OUT/app.zip"
xcrun notarytool submit "$OUT/app.zip" --keychain-profile notary --wait
xcrun stapler staple "Micro Speed Grader.app"
COPYFILE_DISABLE=1 tar -czf "$OUT/Micro-Speed-Grader.app.tar.gz" "Micro Speed Grader.app"
sign() { (cd "$APP" && TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri signer sign -f "$KEY" "$1" >/dev/null); }
sign "$OUT/Micro-Speed-Grader.app.tar.gz"

DMG="$OUT/Micro-Speed-Grader_${VER}_macOS.dmg"
cp "$B/dmg/Micro Speed Grader_${VER}_universal.dmg" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile notary --wait
xcrun stapler staple "$DMG"
ASSETS=("$DMG" "$OUT/Micro-Speed-Grader.app.tar.gz" "$OUT/Micro-Speed-Grader.app.tar.gz.sig")

# Windows: wait for the build, sign its installer for the updater
WIN=""
if [ -n "${SKIP_WINDOWS:-}" ]; then
  echo "SKIP_WINDOWS set: releasing macOS only"
else
  gh run watch "$RUN" -R "$REPO" --exit-status >/dev/null || { echo "the Windows build failed: https://github.com/$REPO/actions/runs/$RUN (SKIP_WINDOWS=1 releases macOS only)" >&2; exit 1; }
  gh run download "$RUN" -R "$REPO" -n windows-installer -D "$OUT/win"
  src=$(ls "$OUT"/win/*.exe | head -1)
  WIN="$OUT/Micro-Speed-Grader_${VER}_Windows-x64-setup.exe"
  mv "$src" "$WIN"
  sign "$WIN"
  ASSETS+=("$WIN" "$WIN.sig")
fi

python3 - "$OUT" "$VER" "$NOTES" "$DL" "$WIN" <<'PY'
import json, sys, datetime, os
out, ver, notes, dl, win = sys.argv[1:6]
mac = {"signature": open(f"{out}/Micro-Speed-Grader.app.tar.gz.sig").read().strip(), "url": f"{dl}/Micro-Speed-Grader.app.tar.gz"}
plat = {"darwin-aarch64": mac, "darwin-x86_64": mac}
if win:
    plat["windows-x86_64"] = {"signature": open(win + ".sig").read().strip(), "url": f"{dl}/{os.path.basename(win)}"}
json.dump({"version": ver, "notes": notes,
           "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "platforms": plat}, open(f"{out}/latest.json", "w"), indent=2)
PY
ASSETS+=("$OUT/latest.json")

cd "$ROOT"
gh release create "v$VER" "${ASSETS[@]}" --target "$SHA" --title "Micro Speed Grader $VER" --notes "${NOTES:-Release $VER}"
echo "released v$VER (files in $OUT)"

#!/bin/bash
# Build, sign, notarize and publish a macOS release that the in-app updater picks up.
#   tools/release-mac.sh 0.3.0 "What changed"
# Needs: Developer ID cert in the keychain, `xcrun notarytool` profile "notary",
# the updater key at ~/.tauri/micro-speed-grader.key, and `gh` logged in.
set -euo pipefail
VER="${1:?version, e.g. 0.3.0}"
NOTES="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
B="$APP/src-tauri/target/release/bundle"
OUT="$(mktemp -d)"
IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Alexander Gadin (8644223FJ6)}"
KEY="${UPDATER_KEY:-$HOME/.tauri/micro-speed-grader.key}"

# version everywhere
python3 - "$APP" "$VER" <<'EOF'
import json, re, sys
app, ver = sys.argv[1], sys.argv[2]
for f in ("src-tauri/tauri.conf.json", "package.json"):
    p = f"{app}/{f}"; d = json.load(open(p)); d["version"] = ver; json.dump(d, open(p, "w"), indent=2)
p = f"{app}/src-tauri/Cargo.toml"; s = open(p).read()
open(p, "w").write(re.sub(r'(?m)^version = "[^"]+"', f'version = "{ver}"', s, count=1))
EOF

"$ROOT/tools/bundle-openslide-mac.sh" >/dev/null
(cd "$APP" && APPLE_SIGNING_IDENTITY="$IDENTITY" TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build -- --bundles app,dmg)

# notarize + staple the app, then rebuild the updater archive from the stapled app
cd "$B/macos"
ditto -c -k --keepParent "Micro Speed Grader.app" "$OUT/app.zip"
xcrun notarytool submit "$OUT/app.zip" --keychain-profile notary --wait
xcrun stapler staple "Micro Speed Grader.app"
COPYFILE_DISABLE=1 tar -czf "$OUT/Micro-Speed-Grader.app.tar.gz" "Micro Speed Grader.app"
(cd "$APP" && TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri signer sign -f "$KEY" "$OUT/Micro-Speed-Grader.app.tar.gz")

DMG="$OUT/Micro-Speed-Grader_${VER}_macOS-arm64.dmg"
cp "$B/dmg/Micro Speed Grader_${VER}_aarch64.dmg" "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile notary --wait
xcrun stapler staple "$DMG"

python3 - "$OUT" "$VER" "$NOTES" <<'EOF'
import json, sys, datetime
out, ver, notes = sys.argv[1:4]
sig = open(f"{out}/Micro-Speed-Grader.app.tar.gz.sig").read().strip()
json.dump({"version": ver, "notes": notes,
           "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "platforms": {"darwin-aarch64": {"signature": sig,
             "url": f"https://github.com/agadin/micro-speed-grader/releases/download/v{ver}/Micro-Speed-Grader.app.tar.gz"}}},
          open(f"{out}/latest.json", "w"), indent=2)
EOF

cd "$ROOT"
gh release create "v$VER" "$DMG" "$OUT/Micro-Speed-Grader.app.tar.gz" "$OUT/Micro-Speed-Grader.app.tar.gz.sig" "$OUT/latest.json" \
  --title "Micro Speed Grader $VER" --notes "${NOTES:-Release $VER}"
echo "released v$VER (files in $OUT)"

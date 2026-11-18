#!/bin/bash
# Puts the official prebuilt OpenSlide (openslide-bin: one self-contained library, only system
# dependencies) where the app bundle picks it up:
#   tools/fetch-openslide.sh mac       -> app/src-tauri/frameworks/libopenslide.1.dylib  (arm64 + x86_64)
#   tools/fetch-openslide.sh windows   -> app/src-tauri/lib/libopenslide-1.dll           (x64)
# The download is pinned and checked against its SHA-256. Bump VERSION and both sums together.
set -euo pipefail
VERSION="4.0.1.2"
SHA_MAC="d4aadd29bbb84f3e9392627f71c52332af094bbea4e56f58e977b7a149448dbb"
SHA_WIN="841bef094e1504a831caaaf767a969be436e30d84bc16a33f4d941953409c150"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$ROOT/app/src-tauri"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
base="https://github.com/openslide/openslide-bin/releases/download/v$VERSION"
sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }
get() { # name sha
  curl -fsSL --retry 3 -o "$TMP/$1" "$base/$1"
  [ "$(sha "$TMP/$1")" = "$2" ] || { echo "checksum mismatch for $1" >&2; exit 1; }
}
case "${1:?mac or windows}" in
  mac)
    n="openslide-bin-$VERSION-macos-arm64-x86_64"
    get "$n.tar.xz" "$SHA_MAC"
    tar -xf "$TMP/$n.tar.xz" -C "$TMP"
    rm -rf "$T/frameworks" && mkdir -p "$T/frameworks"
    cp "$TMP/$n/lib/libopenslide.1.dylib" "$T/frameworks/"
    cp "$TMP/$n/licenses/OpenSlide/COPYING.LESSER" "$T/frameworks/OpenSlide-LICENSE.txt"
    lipo -info "$T/frameworks/libopenslide.1.dylib"
    ;;
  windows)
    n="openslide-bin-$VERSION-windows-x64"
    get "$n.zip" "$SHA_WIN"
    (cd "$TMP" && unzip -q "$n.zip")
    rm -rf "$T/lib" && mkdir -p "$T/lib"
    cp "$TMP/$n/bin/libopenslide-1.dll" "$T/lib/"
    cp "$TMP/$n/licenses/OpenSlide/COPYING.LESSER" "$T/lib/OpenSlide-LICENSE.txt"
    ls -l "$T/lib"
    ;;
  *) echo "usage: $0 mac|windows" >&2; exit 2 ;;
esac

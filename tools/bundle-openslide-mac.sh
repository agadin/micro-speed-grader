#!/bin/bash
# Copies Homebrew's OpenSlide and every non-system library it depends on into
# app/src-tauri/frameworks/, rewriting their links to @loader_path so the .app runs
# without Homebrew. Run before `npm run tauri build` on macOS.
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/app/src-tauri/frameworks"
SRC="$(brew --prefix openslide)/lib/libopenslide.1.dylib"
rm -rf "$OUT" && mkdir -p "$OUT"

deps() { otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -E '^(/opt/homebrew|/usr/local)/' || true; }

queue=("$SRC")
seen=" "
while [ ${#queue[@]} -gt 0 ]; do
  lib="${queue[0]}"; queue=("${queue[@]:1}")
  name="$(basename "$lib")"
  case "$seen" in *" $name "*) continue ;; esac
  seen="$seen$name "
  cp -L "$lib" "$OUT/$name"
  chmod u+w "$OUT/$name"
  for d in $(deps "$lib"); do queue+=("$d"); done
done

for f in "$OUT"/*.dylib; do
  install_name_tool -id "@loader_path/$(basename "$f")" "$f" 2>/dev/null
  for d in $(deps "$f"); do
    install_name_tool -change "$d" "@loader_path/$(basename "$d")" "$f" 2>/dev/null
  done
  codesign --force --sign - "$f" 2>/dev/null
done
ls "$OUT"

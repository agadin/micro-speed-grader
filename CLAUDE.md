# Micro Speed Grader: notes for Claude

## Version numbers and releases

The GitHub releases page is the record of versions. It must go up one step at a time with no gaps: 0.3.3 → 0.3.4 → 0.4.0. Gaps happened before (0.2.3 jumped to 0.3.2) because versions 0.3.0 and 0.3.1 were bumped in commits and never released. Don't do that again.

**Rules**

- **Only change the version when releasing.** "Commit this" never means bump the version. When the user asks to "commit and bump the version", confirm they want a release, and release that same version straight away.
- **Before choosing a number, check what's actually released:** `gh release list --limit 5`. The next version follows the latest release, not whatever is in `package.json`.
- **Pick the step:** patch (0.3.3 → 0.3.4) for fixes and small additions; minor (0.3.x → 0.4.0) for a notable new feature, when the user asks. Never skip a number, and never reuse one. If a release fails part-way (e.g. Apple notarization), fix the problem and release the same number again; don't move on to the next one.
- **The version lives in five files, which must always match:** `app/package.json`, `app/package-lock.json` (top two entries), `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` and `app/src-tauri/Cargo.lock` (the `app` package; `cargo check` updates it).

**Steps**

1. `gh release list --limit 5` and `git status`. Everything to ship must be committed and pushed to `main`.
2. Bump all five files to the new version, run `cd app/src-tauri && cargo check`, and commit as `v<version>` (e.g. `v0.3.4`). Push to `main`.
3. `tools/release.sh <version> "<notes for users>"`. It refuses to run unless HEAD is `origin/main` and the version files say `<version>`. It starts the Windows build on GitHub Actions (Build workflow), builds, signs and notarizes the universal macOS app and DMG, waits for the Windows installer and signs it for the updater locally (the updater key never goes to GitHub), writes `latest.json` (Apple silicon, Intel, Windows) and creates the GitHub release on that commit. It takes 10–15 minutes; run it in the background. If only the Windows build fails, fix it and rerun; `SKIP_WINDOWS=1` releases macOS only (say so in the notes).
4. Nothing to revert: the script no longer rewrites version files. `git status` should be clean.
5. Check: `gh release view v<version>` lists `Micro-Speed-Grader_<version>_macOS.dmg`, `Micro-Speed-Grader.app.tar.gz` and its `.sig`, `Micro-Speed-Grader_<version>_Windows-x64-setup.exe` and its `.sig`, and `latest.json`, and the release is marked Latest.

Notes:

- Release notes are read by graders in the update banner: describe what changed for them in plain words, not commit messages.
- If notarization fails with "A required agreement is missing or has expired", the user has to accept the agreement at developer.apple.com. Then rerun step 3 with the same version.
- Updater signatures must name the version (`tauri signer sign --app-version`): installed apps since 0.3.2 have `requireSignedVersion` on and refuse anything else with "The update signature does not specify the version it was signed for". `release.sh` does this and refuses to publish a signature without it; releases 0.3.2–0.3.8 lacked it, so their update button never worked.
- Signing details (Developer ID, the `notary` keychain profile, the updater key at `~/.tauri/micro-speed-grader.key`) are in `tools/release.sh`. OpenSlide comes from `tools/fetch-openslide.sh` (pinned openslide-bin, checksummed); run `tools/fetch-openslide.sh mac` once on a new machine before `tauri dev`/`cargo check`. Losing the updater key breaks updates for every installed copy.

## Before committing

- `cd app && npx tsc --noEmit && npm run test:logic` (CI runs these too, on every push and PR touching `app/` or `docs/help/`)
- For UI changes, also run `UI_BROWSER=chromium npm run test:ui` (dev server running). WebKit's headless clicks are unreliable on this machine.
- `demo.zip` at the repo root is the user's own file: never commit it.
- Help pages live in `docs/help/*.md` (shown in the app and on GitHub). When a feature changes, update its page. `test:logic` checks that every link, image and in-app help reference resolves.

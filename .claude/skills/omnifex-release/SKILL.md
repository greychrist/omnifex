---
name: omnifex-release
description: Use when Greg asks to cut a new OmniFex release (phrases like "release", "ship it", "cut v0.4.x", "increment the release number", "build it"). Default flow builds a signed + notarized + stapled .dmg and .zip locally via `OMNIFEX_NOTARIZE=1 npm run make`, verifies them against Gatekeeper, and publishes a GitHub release with both artifacts attached, marked `--latest` so the in-app updater picks it up on the next check. Pass `local` (e.g. "release local", "build it local") to skip the GitHub upload entirely and stop after the local build + verification — that's the safety hatch for inspecting a build before users see it.
---

# OmniFex Release

OmniFex (by GreyChrist) ships macOS-only builds, signed with Greg's Apple
Developer ID and notarized by Apple. No CI. No GitHub Actions. The repo's
`.github/workflows/` was deleted in v0.3.12. The URL-based updater was retired
the same release, replaced with a local-folder scanner in v0.3.13, and then
restored as the only update source in May 2026 when the repo went public — see
`electron/services/updater.ts`. The app was renamed GreyChrist → OmniFex in
v0.4.2; bundle ID, .app name, and artifact filenames all carry the OmniFex name
now; the company stays GreyChrist, LLC. This skill captures the exact release
runbook.

**Running the skill ships to users.** Every running OmniFex polls
`GET /repos/greychrist/omnifex/releases/latest` and offers the new build. There
is no draft gate — `gh release create --latest` goes live the moment it returns.
If you need to inspect a build before users see it, use `local` mode (no upload)
instead of relying on a manual publish step.

## When to use

- Greg says "release", "cut a release", "increment the release number",
  "ship v0.4.X", "build it".
- Expected input: one version argument like `0.4.3`, or nothing (bump the patch
  of the current `package.json` version).
- Append `local` (e.g. "release local 0.4.5", "build it local") to do a
  local-only build with no GitHub upload. The runbook still signs, notarizes,
  and verifies — it skips steps 8–9 and reports the local paths instead.

## The Iron Law

**Never upload an artifact that has not passed the Gatekeeper gate in step 7.**

Signing and notarization are fully automatic — `OMNIFEX_NOTARIZE=1` is the only
thing that turns them on, and `forge.config.ts` handles the rest for both the
`.app` and the `.dmg`. There is nothing manual to remember and nothing to
remind Greg about. What *can* go wrong is silence: a missing keychain profile,
an expired certificate, or a notary rejection can leave you holding an
unsigned artifact that looks completely normal on disk. Step 7 exists to make
that loud, and it is the one step that must never be skipped or assumed.

Signing setup (done 2026-08-21, does not need redoing):

- **Certificate:** `Developer ID Application: Gregory Christie (37YG3HV4BV)` in
  the login keychain. Note the Team ID — `C9Z3X7N4Y2` on the older "Apple
  Development" cert belongs to a different, pre-paid-enrollment team and cannot
  notarize.
- **Notary credentials:** the `omnifex-notary` keychain profile, created with
  `xcrun notarytool store-credentials` (Apple ID + app-specific password).
  `signing/index.ts` looks for exactly that name; `APPLE_KEYCHAIN_PROFILE`
  overrides it.
- **Entitlements:** `signing/entitlements.plist` and
  `signing/entitlements.inherit.plist`. Both are required; the renderer that
  JITs is a helper process and reads the inherit file.
- **DMG:** signed / notarized / stapled by the `postMake` hook in
  `forge.config.ts` (`signing/dmg.ts`), because `maker-dmg` wraps the already
  notarized `.app` in a fresh container that carries no signature of its own.

## Preconditions to verify before starting

```bash
git log --oneline -3   # know what's landing
gh auth status         # gh CLI can create releases

# Signing prerequisites — check BEFORE the long build, not after
security find-identity -v -p codesigning | grep "Developer ID Application"
xcrun notarytool history --keychain-profile omnifex-notary | head -3
```

If either signing check fails, stop and tell Greg which one — a build that
reaches step 7 and fails there has cost 15+ minutes for nothing. A missing
profile is recreated with `xcrun notarytool store-credentials omnifex-notary
--apple-id <id> --team-id 37YG3HV4BV`.

Getting the tree committed and pushed is step 0 of the runbook, not a
precondition — it's work to perform, not a gate to check.

## The runbook (execute in order)

### 0. Sync the working tree (both modes)

The release must ship from a state that exists on the remote. Run this first,
before the version bump and before the long build — a build started on unpushed
work produces artifacts whose source nobody else can see.

```bash
git branch --show-current              # must be main
git fetch origin                       # REQUIRED before the next line
git status --porcelain                 # uncommitted work?
git rev-list --count origin/main..HEAD # commits not yet on the remote?
```

`git fetch origin` is not optional. `origin/main` is a local ref that only moves
when you fetch; comparing against a stale one reports "0 unpushed" for work the
remote has never seen.

Then act on what you found:

- **`git status --porcelain` non-empty** → stage everything, infer a
  conventional-commit message from the diff (`fix:` / `feat:` / `chore:` etc.),
  and commit. Do not ask Greg and do not show him the message for approval
  first — he wants outstanding work rolled into the release automatically.
- **`git rev-list --count origin/main..HEAD` greater than 0** →
  `git push origin main`.
- **Both clean** → say so in one line and go to step 1. Do not create an empty
  commit.

Stop and surface it instead of committing if the diff contains apparent secrets
(`.env`, credentials, tokens, keys). Note that `signing/.gitignore` already
blocks `*.p8` / `*.p12` / `*.cer` from being committed by accident.

If the branch is not `main`, stop and ask — the updater serves whatever
`--latest` points at, and releasing from a side branch ships unreviewed work to
every running OmniFex.

After step 0 the tree is clean and pushed, so the "bump version" commit in
step 4 stays a clean single-purpose diff.

### 1. Pick the version

```bash
NEW_VERSION=0.4.X   # patch bump unless Greg says otherwise
```

Check that `v$NEW_VERSION` isn't already a tag (remote or local). If it is, pick
the next patch and tell Greg.

### 2. Pre-flight gates

```bash
npm run check && npm test && npm run build
```

All three must pass. If `test:coverage` is wanted, run it — but there's no
enforced threshold anymore (removed in v0.3.12); treat failures in the coverage
tool itself as blocking and threshold drift as informational.

### 3. Bump version + update CHANGELOG

- `package.json`: bump `version` to `$NEW_VERSION`.
- `CHANGELOG.md`: add a `## [$NEW_VERSION] — YYYY-MM-DD` section at the top,
  above the previous entry. Summarize commits since the last tag
  (`git log v<prev>..HEAD --oneline`). Use Keep a Changelog sections:
  `### Added`, `### Changed`, `### Fixed`, `### Removed`. Installers are signed
  and notarized as of v0.4.135 — do not carry forward the old "Installers
  remain **unsigned**" line from earlier entries.

### 4. Commit the bump

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to $NEW_VERSION"
```

### 5. Tag and push

```bash
git tag v$NEW_VERSION
git push origin main v$NEW_VERSION
```

Pushing the tag does **not** trigger anything on GitHub anymore — the Actions
workflows are gone. This is just the git-history marker.

### 6. Build, sign, and notarize

Wipe `out/make` first so only the new release's artifacts remain on disk. Old
DMG/ZIP files from prior releases otherwise accumulate and the
`gh release create` glob in step 9 can pick up the wrong file.

```bash
rm -rf out/make
OMNIFEX_NOTARIZE=1 npm run make
```

**`OMNIFEX_NOTARIZE=1` is what makes this a shippable build.** Without it the
build succeeds and produces artifacts that are signed but never notarized —
`osxNotarize` and the DMG `postMake` hook both no-op. That gate exists so
ordinary local packaging doesn't upload to Apple; a release must always set it.

Budget 15–25 minutes. The build itself is 8–12; the rest is two round trips
through Apple's notary queue (once for the `.app` during packaging, once for
the `.dmg` in `postMake`). Queue time is normally a few minutes each. The first
ever submission from a new team took ~90 minutes on 2026-08-21 — that was
one-time enrollment overhead, not the steady state. Run this in the background
and poll rather than blocking, and if it seems stalled, query Apple directly
instead of guessing:

```bash
xcrun notarytool history --keychain-profile omnifex-notary | head -12
```

`status: In Progress` means Apple still has it and there is nothing to fix.
That query is independent of the build process, so it works even if the build's
`--wait` has lost its connection.

Produces:
- `out/make/OmniFex-$NEW_VERSION-arm64.dmg`
- `out/make/zip/darwin/arm64/OmniFex-darwin-arm64-$NEW_VERSION.zip`

### 7. Verify the Gatekeeper gate (MANDATORY, both modes)

Do not skip this and do not infer it from a zero exit code in step 6.

```bash
APP=out/OmniFex-darwin-arm64/OmniFex.app
DMG=out/make/OmniFex-$NEW_VERSION-arm64.dmg

codesign --verify --deep --strict "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "TeamIdentifier|flags"
spctl -a -vvv -t exec "$APP"
xcrun stapler validate "$APP"

spctl -a -vvv -t open --context context:primary-signature "$DMG"
xcrun stapler validate "$DMG"
```

Required results — **all** of them, or stop and do not upload:

- `spctl` on both: `accepted` and `source=Notarized Developer ID`
- `stapler validate` on both: `The validate action worked!`
- `TeamIdentifier=37YG3HV4BV`
- `flags=0x10000(runtime)` on the app (hardened runtime; notarization requires it)

An unstapled artifact is the dangerous case: it passes Gatekeeper on a machine
that can reach Apple and fails on one that can't, so it looks fine here and
breaks for a user offline. `stapler validate` is the only check that catches it.

The `.zip` is not separately signed — it contains the same stapled `.app`, which
is what the updater extracts, so verifying the app covers it.

### 8. Extract release notes for the GitHub release body

**Skip this step in `local` mode.**

```bash
awk -v ver="$NEW_VERSION" '
  $0 ~ "^## \\[" ver "\\]" { in_range=1; print; next }
  in_range && /^## \[/ { exit }
  in_range
' CHANGELOG.md > /tmp/release-notes-$NEW_VERSION.md
```

Verify it grabbed only the new section (not everything down to the end of the
file). **Don't use the `awk '/start/,/end/' | sed '$d'` form** — on BSD awk
(macOS default) the end pattern is tested on the start line itself, and
`/^## \[/` matches the version header that just opened the range. Result: every
release cut before 2026-05-17 had an empty release-notes body. The flag-based
loop above avoids that trap.

### 9. Create and publish the GitHub release

**Skip this step in `local` mode.**

```bash
gh release create v$NEW_VERSION \
  "out/make/OmniFex-$NEW_VERSION-arm64.dmg" \
  "out/make/zip/darwin/arm64/OmniFex-darwin-arm64-$NEW_VERSION.zip" \
  --latest \
  --title "v$NEW_VERSION" \
  --notes-file /tmp/release-notes-$NEW_VERSION.md
```

`--latest` flips `releases/latest` to this version immediately. Every running
OmniFex sees the update on its next check (or restart). There is no draft step —
that was dropped May 2026 because the manual publish click in the GitHub UI was
friction without much safety value. If you need a "look before users see it"
mode, use `local` mode (no upload) and inspect the `.dmg` directly.

### 10. Rebuild Electron ABI

```bash
npm run rebuild:electron
```

`npm run make` leaves `better-sqlite3` in Electron ABI state, but run this
defensively so Greg's dev app works on next `npm start`. (Project memory:
"Rebuild Electron ABI after tests — Run `npm run rebuild:electron` after any
vitest run, before Greg restarts the app.")

### 11. Report

Default mode — tell Greg:
- Published release URL (from step 9's output).
- Local artifact paths (DMG + ZIP).
- The step 7 results, explicitly: signed, notarized, stapled, Gatekeeper
  accepted. State it as verified output, not as an assumption.
- Reminder: the release is live; every running OmniFex will see it on its next
  check or restart.

`local` mode — tell Greg:
- Local artifact paths (DMG + ZIP).
- The step 7 results, same as above.
- Reminder: nothing was uploaded to GitHub; users will not see this build.

## What not to do

- **Don't** run `npm run make` without `OMNIFEX_NOTARIZE=1` for a release. It
  exits 0 and produces normal-looking artifacts that were never notarized.
- **Don't** treat step 6 exiting 0 as proof of notarization. Run step 7.
- **Don't** upload when `stapler validate` fails even if `spctl` says accepted —
  that combination means the ticket is on Apple's servers but not in the file,
  which breaks for offline users only.
- **Don't** use `--draft` instead of `--latest`. Drafts were the previous
  default and Greg explicitly removed the manual publish click — using
  `--draft` again would silently re-introduce the friction without an obvious
  failure to surface it. If a build genuinely shouldn't be visible, use `local`
  mode and don't upload at all.
- **Don't** try to re-point an existing `v0.4.X` tag (see v0.3.11 conflict in
  git history — we bumped to 0.3.12 to avoid rewriting). If the tag exists, pick
  the next number and tell Greg why.
- **Don't** push without a pre-flight `npm run check && npm test`. There's no CI
  backstop anymore and the release goes straight to users with no draft gate.
- **Don't** commit `package.json` bump together with unrelated feature work —
  keep the "bump version" commit clean. Step 0 exists to get unrelated work
  committed separately first.
- **Don't** start the build with uncommitted or unpushed work. Step 0 is not a
  formality: the build takes 15–25 minutes and `gh release create --latest` goes
  live the moment it returns, so a release cut from local-only source is public
  before anyone notices the source isn't.
- **Don't** compare against `origin/main` without `git fetch origin` first — a
  stale ref reports everything as already pushed.
- **Don't** forget to rebuild the Electron ABI. Greg will hit a crash on next
  `npm start` if you skip step 10.
- **Don't** rename artifact filenames without also updating the regex at
  `electron/services/updater.ts` — the updater parses versions from the filename
  pattern.
- **Don't** re-add "unsigned" / "right-click → Open" language to the CHANGELOG,
  the release notes, or the report. It stopped being true at v0.4.135.

## Reference: release-cost baseline

- GitHub Actions minutes consumed per release: **0**. All builds are local.
- Apple notarization: included in the $99/yr Developer Program membership, no
  per-submission cost, no quota worth tracking.
- Release-asset storage on GitHub: each release ≈ 250 MB (DMG + ZIP).

## Current-state details

- Repo: `greychrist/omnifex` on GitHub (public, AGPL-3.0). The shipping product
  is OmniFex; the publisher is GreyChrist.
- Current version lives in `package.json:4`.
- Tag format: `v$SEMVER` (lowercase `v`).
- Artifact filenames follow `OmniFex-$SEMVER-arm64.dmg` /
  `OmniFex-darwin-arm64-$SEMVER.zip` — the updater at
  `electron/services/updater.ts` parses versions from the ZIP regex
  `/^OmniFex-darwin-arm64-(\d+\.\d+\.\d+)\.zip$/`, so don't rename without
  updating both.
- Bundle ID: `com.omnifex.app`. Executable: `omnifex`. App bundle:
  `OmniFex.app`. .app installs to `/Applications/OmniFex.app`.
- Apple Team ID: `37YG3HV4BV`. Signing config lives in `signing/` and is wired
  into `forge.config.ts`; unit-tested by `electron/__tests__/signing-config.test.ts`
  and `electron/__tests__/signing-dmg.test.ts`.

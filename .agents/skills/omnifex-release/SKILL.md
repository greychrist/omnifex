---
name: omnifex-release
description: Use when Greg asks to cut a new OmniFex release (phrases like "release", "ship it", "cut v0.4.x", "increment the release number", "build it"). Default flow builds .dmg + .zip locally via `npm run make` and publishes a GitHub release with both artifacts attached, marked `--latest` so the in-app updater picks it up on the next check. Pass `local` (e.g. "release local", "build it local") to skip the GitHub upload entirely and stop after the local build — that's the safety hatch for inspecting a build before users see it.
---

# OmniFex Release

OmniFex (by GreyChrist) ships unsigned macOS-only builds. No CI. No GitHub Actions. The repo's `.github/workflows/` was deleted in v0.3.12. The URL-based updater was retired the same release, replaced with a local-folder scanner in v0.3.13, and then restored as the only update source in May 2026 when the repo went public — see `electron/services/updater.ts`. The app was renamed GreyChrist → OmniFex in v0.4.2; bundle ID, .app name, and artifact filenames all carry the OmniFex name now; the company stays GreyChrist, LLC. This skill captures the exact release runbook.

**Running the skill ships to users.** Every running OmniFex polls `GET /repos/greychrist/omnifex/releases/latest` and offers the new build. There is no draft gate — `gh release create --latest` goes live the moment it returns. If you need to inspect a build before users see it, use `local` mode (no upload) instead of relying on a manual publish step.

## When to use

- Greg says "release", "cut a release", "increment the release number", "ship v0.4.X", "build it".
- Expected input: one version argument like `0.4.3`, or nothing (bump the patch of the current `package.json` version).
- Append `local` (e.g. "release local 0.4.5", "build it local") to do a local-only build with no GitHub upload — useful for sanity-checking artifacts before a real release. The runbook skips steps 7–8 in that mode and reports the local paths instead.

## The Iron Law

**Every release is unsigned.** Remind Greg before running `npm run make` — macOS Gatekeeper will block first launch, users need to right-click → Open. Greg has acknowledged this since v0.3.0 but the reminder is mandatory per project memory.

The osxSign cert (`'GreyChrist Local Sign'` in `forge.config.ts`) is a self-signed cert in Greg's login keychain that gives the bundle a stable identity hash for TCC stickiness. The cert name still says GreyChrist; that's intentional — cert name is independent of bundle ID and renaming requires recreating the cert. Cleanup plan when Greg buys Developer ID: swap the identity name, re-enable hardened runtime, add notarization config.

## Preconditions to verify before starting

```
git status          # working tree clean (or only intended changes)
git log --oneline -3   # know what's landing
gh auth status      # gh CLI can create releases
```

If there are uncommitted changes, auto-commit them before starting the release. Stage everything, infer a conventional-commit message from the diff (`fix:` / `feat:` / `chore:` etc.), and commit. Do not ask Greg — he wants these rolled into the release automatically. The only exception is if the diff contains apparent secrets (`.env`, credentials); in that case stop and surface it. After this auto-commit, the release's "bump version" commit still goes in as its own clean-diff commit in step 4.

## The runbook (execute in order)

### 0. Check the Codex Agent SDK before anything else

Run the `update-sdk` command's workflow (see `.Codex/commands/update-sdk.md`) to compare the installed `@anthropic-ai/Codex-agent-sdk` and its overlapping deps against npm's latest. **Always do this before a release** — Greg has gone weeks between releases before, and shipping on a stale SDK has bitten us.

Before proposing any upgrade:

- Diff the installed version against latest. If the major version bumped, fetch the changelog/release notes from npm or GitHub and skim for breaking changes.
- Cross-reference breaking changes against this repo's SDK usage (`electron/services/sessions.ts` is the primary `query()` consumer; also check `electron/services/agents.ts`, `electron/services/mcp.ts`, and anywhere `@anthropic-ai/Codex-agent-sdk` is imported).
- **If the upgrade looks safe (patch/minor, no breaking API changes touching our code paths):** tell Greg what changed, ask permission, then upgrade and run the full verification gate (`npm run check`, `npm run build`, `npm run test:coverage`) before continuing the release.
- **If the upgrade looks risky (major bump, breaking changes that touch our code, or unclear impact):** STOP. Surface the specifics to Greg — what version, what changed, which files are affected, what work the upgrade likely requires — and let him decide whether to (a) fix and ship together, (b) ship the release on the old SDK and tackle the upgrade separately, or (c) defer the release. Do not silently skip the upgrade and continue, and do not silently apply it.

If an SDK upgrade lands here, it gets its own commit (per the `update-sdk` workflow) before the version-bump commit in step 4.

### 1. Pick the version

```bash
NEW_VERSION=0.4.X   # patch bump unless Greg says otherwise
```

Check that `v$NEW_VERSION` isn't already a tag (remote or local). If it is, pick the next patch and tell Greg.

### 2. Pre-flight gates

```bash
npm run check && npm test && npm run build
```

All three must pass. If `test:coverage` is wanted, run it — but there's no enforced threshold anymore (removed in v0.3.12); treat failures in the coverage tool itself as blocking and threshold drift as informational.

### 3. Bump version + update CHANGELOG

- `package.json`: bump `version` to `$NEW_VERSION`.
- `CHANGELOG.md`: add a `## [$NEW_VERSION] — YYYY-MM-DD` section at the top, above the previous entry. Summarize commits since the last tag (`git log v<prev>..HEAD --oneline`). Use Keep a Changelog sections: `### Added`, `### Changed`, `### Fixed`, `### Removed`. Each release still notes "Installers remain **unsigned**."

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

Pushing the tag does **not** trigger anything on GitHub anymore — the Actions workflows are gone. This is just the git-history marker.

### 6. Build locally

Wipe `out/make` first so only the new release's artifacts remain on disk. Old DMG/ZIP files from prior releases otherwise accumulate and the `gh release create` glob in step 8 can pick up the wrong file.

```bash
rm -rf out/make
npm run make
```

Takes 8–12 minutes. Produces:
- `out/make/OmniFex-$NEW_VERSION-arm64.dmg`
- `out/make/zip/darwin/arm64/OmniFex-darwin-arm64-$NEW_VERSION.zip`

### 7. Extract release notes for the GitHub release body

**Skip this step in `local` mode.**

```bash
awk -v ver="$NEW_VERSION" '
  $0 ~ "^## \\[" ver "\\]" { in_range=1; print; next }
  in_range && /^## \[/ { exit }
  in_range
' CHANGELOG.md > /tmp/release-notes-$NEW_VERSION.md
```

Verify it grabbed only the new section (not everything down to the end of the file). **Don't use the `awk '/start/,/end/' | sed '$d'` form** — on BSD awk (macOS default) the end pattern is tested on the start line itself, and `/^## \[/` matches the version header that just opened the range. Result: every release cut before 2026-05-17 had an empty release-notes body. The flag-based loop above avoids that trap.

### 8. Create and publish the GitHub release

**Skip this step in `local` mode.**

```bash
gh release create v$NEW_VERSION \
  "out/make/OmniFex-$NEW_VERSION-arm64.dmg" \
  "out/make/zip/darwin/arm64/OmniFex-darwin-arm64-$NEW_VERSION.zip" \
  --latest \
  --title "v$NEW_VERSION" \
  --notes-file /tmp/release-notes-$NEW_VERSION.md
```

`--latest` flips `releases/latest` to this version immediately. Every running OmniFex sees the update on its next check (or restart). There is no draft step — that was dropped May 2026 because the manual publish click in the GitHub UI was friction without much safety value: by the time the release is built and pushed, the artifacts have already been smoke-tested by the pre-flight gate. If you need a "look before users see it" mode, use `local` mode (no upload) and inspect the `.dmg` directly.

### 9. Rebuild Electron ABI

```bash
npm run rebuild:electron
```

`npm run make` leaves `better-sqlite3` in Electron ABI state, but run this defensively so Greg's dev app works on next `npm start`. (Project memory: "Rebuild Electron ABI after tests — Run `npm run rebuild:electron` after any vitest run, before Greg restarts the app.")

### 10. Report

Default mode — tell Greg:
- Published release URL (from step 8's output).
- Local artifact paths (DMG + ZIP).
- Reminder: the release is live; every running OmniFex will see it on its next check or restart.
- Reminder: build is unsigned.

`local` mode — tell Greg:
- Local artifact paths (DMG + ZIP).
- Reminder: nothing was uploaded to GitHub; users will not see this build.
- Reminder: build is unsigned.

## What not to do

- **Don't** use `--draft` instead of `--latest`. Drafts were the previous default and Greg explicitly removed the manual publish click — using `--draft` again would silently re-introduce the friction without an obvious failure to surface it. If a build genuinely shouldn't be visible, use `local` mode and don't upload at all.
- **Don't** try to re-point an existing `v0.4.X` tag (see v0.3.11 conflict in git history — we bumped to 0.3.12 to avoid rewriting). If the tag exists, pick the next number and tell Greg why.
- **Don't** push without a pre-flight `npm run check && npm test`. There's no CI backstop anymore and the release goes straight to users with no draft gate.
- **Don't** commit `package.json` bump together with unrelated feature work — keep the "bump version" commit clean.
- **Don't** forget to rebuild the Electron ABI. Greg will hit a crash on next `npm start` if you skip step 9.
- **Don't** rename artifact filenames without also updating the regex at `electron/services/updater.ts` — the updater parses versions from the filename pattern.

## Reference: release-cost baseline

- GitHub Actions minutes consumed per release: **0**. All builds are local.
- Release-asset storage on GitHub: each release ≈ 250 MB (DMG + ZIP). Private-repo storage quota applies but is generous enough that periodic releases don't hit limits in practice.

## Current-state details

- Repo: `greychrist/omnifex` on GitHub (public, AGPL-3.0). The shipping product is OmniFex; the publisher is GreyChrist.
- Current version lives in `package.json:4`.
- Tag format: `v$SEMVER` (lowercase `v`).
- Artifact filenames follow `OmniFex-$SEMVER-arm64.dmg` / `OmniFex-darwin-arm64-$SEMVER.zip` — the updater at `electron/services/updater.ts` parses versions from the ZIP regex `/^OmniFex-darwin-arm64-(\d+\.\d+\.\d+)\.zip$/`, so don't rename without updating both.
- Bundle ID: `com.omnifex.app`. Executable: `omnifex`. App bundle: `OmniFex.app`. .app installs to `/Applications/OmniFex.app`.

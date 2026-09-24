---
name: omnifex-release
description: Use when Greg asks to cut, ship, build or release a new OmniFex version ("release", "ship it", "cut v0.4.x", "increment the release number", "build it", "commit and push and release"). Outstanding work is committed and pushed automatically as part of the run. Append `local` to build + verify without publishing.
argument-hint: "[version] [local]"
allowed-tools: Bash(bash ${CLAUDE_SKILL_DIR}/scripts/*)
---

# OmniFex Release

Signed + notarized macOS build, published as `--latest` on GitHub. No CI, no
draft gate: `gh release create --latest` is live the moment it returns and every
running OmniFex offers it on its next check. `local` mode stops after
verification and uploads nothing.

**Iron law: never upload an artifact `scripts/gatekeeper.sh` has not passed.**

## Preflight (computed when this skill loaded)

```
!`bash ${CLAUDE_SKILL_DIR}/scripts/preflight.sh`
```

Act on it before anything else:

- Any `STATUS:` line → stop and tell Greg which one. Do not start the build.
- `uncommitted > 0` → stage everything, commit with a conventional-commit
  message inferred from the diff, no approval step. Stop instead if the diff
  contains secrets (`.env`, tokens, keys).
- `unpushed > 0` → `git push origin main`.
- Both zero → say so in one line. No empty commit.
- Branch not `main` → stop and ask; `--latest` ships whatever it points at.
- Version: `$ARGUMENTS` if given, else `next patch`. If preflight says the tag
  exists, use the next free patch and say why.

## Runbook

1. **Gates** — `npm run check && npm test && npm run build`. All three pass or stop.
2. **Release notes** — write the CHANGELOG body for this version to
   `/tmp/changelog-$V.md` with the Write tool (body only: `### Added` /
   `### Changed` / `### Fixed` / `### Removed`, Keep-a-Changelog style,
   summarising the `commits since` list from preflight). Never say installers
   are unsigned; they have been signed since v0.4.135.
3. **README** — open `README.md` and ask, per changelog item: does the Features
   section now describe the app wrongly or incompletely? Fix only what that
   touches, in the section's own voice, no version numbers or "new in". Most
   releases need nothing; report "checked, no change" rather than inventing one.
4. **Bump** — `bash ${CLAUDE_SKILL_DIR}/scripts/bump.sh $V < /tmp/changelog-$V.md`
   (edits `package.json` and `CHANGELOG.md`; refuses an existing tag).
5. **Commit, tag, push** —
   `git add package.json CHANGELOG.md README.md && git commit -m "chore: bump version to $V" && git tag v$V && git push origin main v$V`.
   Include README.md only if step 3 changed it.
6. **Build** — run **in the background** (`run_in_background: true`), then wait
   for the task notification. Do not `sleep`, do not poll with `tail`.
   ```bash
   rm -rf out/make && OMNIFEX_NOTARIZE=1 npm run make > /tmp/release-$V-make.log 2>&1
   ```
   Normal duration 15–25 min (build 8–12 + two notary round trips). Past 30 min:
   `xcrun notarytool history --keychain-profile omnifex-notary | head -12` —
   `In Progress` means Apple still has it. `OMNIFEX_NOTARIZE=1` is the only
   thing that makes this build shippable; without it the run exits 0 unsigned.
7. **Gatekeeper gate** — `bash ${CLAUDE_SKILL_DIR}/scripts/gatekeeper.sh $V`.
   Non-zero exit → do not upload; report the FAIL lines. `local` mode: skip to 10.
8. **Publish** —
   ```bash
   bash ${CLAUDE_SKILL_DIR}/scripts/release-notes.sh $V
   gh release create v$V "out/make/OmniFex-$V-arm64.dmg" \
     "out/make/zip/darwin/arm64/OmniFex-darwin-arm64-$V.zip" \
     --latest --title "v$V" --notes-file /tmp/release-notes-$V.md
   ```
9. **Confirm** — `bash ${CLAUDE_SKILL_DIR}/scripts/publish-check.sh $V`. This
   reads the same `releases/latest` endpoint the updater polls. It is the only
   post-publish check; `gh release view --json isLatest` does not exist.
10. **Rebuild ABI** — `npm run rebuild:electron`, so Greg's next `npm start` works.

## Report

- Release URL and the two artifact paths (local mode: paths only, "nothing uploaded").
- Gatekeeper result as verified output: signed, notarized, stapled, accepted.
- What step 3 did to the README, including "checked, nothing needed".
- Default mode: the release is live for every running OmniFex.

## Don't

- Don't use `--draft`; Greg removed the manual publish click on purpose.
- Don't re-point an existing tag; take the next number.
- Don't fold feature work into the bump commit; preflight commits it separately first.
- Don't rename artifacts without updating the regex in `electron/services/updater.ts`.
- Don't skip step 10.

Signing setup, identifiers and notary troubleshooting: `reference/signing.md`.

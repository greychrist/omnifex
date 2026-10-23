# Signing and notarization reference

Set up 2026-08-21; does not need redoing. Read this only when
`scripts/preflight.sh` reports a signing STATUS line or `scripts/gatekeeper.sh`
fails.

## What is configured

- **Certificate:** `Developer ID Application: Gregory Christie (37YG3HV4BV)` in
  the login keychain. The older "Apple Development" cert with Team ID
  `C9Z3X7N4Y2` belongs to a pre-paid-enrollment team and cannot notarize.
- **Notary credentials:** keychain profile `omnifex-notary`, created with
  `xcrun notarytool store-credentials omnifex-notary --apple-id <id> --team-id 37YG3HV4BV`
  (Apple ID + app-specific password). `signing/index.ts` looks for exactly that
  name; `APPLE_KEYCHAIN_PROFILE` overrides it.
- **Entitlements:** `signing/entitlements.plist`, for the bundled node
  (`Contents/MacOS/omnifexd`: JIT, unsigned executable memory, library
  validation off for the .node addons). Everything else — the Swift app, the
  addons, node-pty's `spawn-helper` — is hardened runtime with no entitlements
  (`entitlementsFor` in `signing/index.ts`).
- **Order:** `scripts/package-mac.ts` signs every Mach-O inside-out, then the
  bundle; `notarizeApp` zips, submits and staples the app; the release zip is
  made from the stapled app; the DMG is built around it and then signed,
  notarized and stapled itself (`notarizeDmg`), because a disk image is a fresh
  container with no signature of its own.
- **Gate:** `OMNIFEX_NOTARIZE=1` is the only switch. Without it `npm run make`
  exits 0 and produces signed-but-never-notarized artifacts. Unit tests:
  `electron/__tests__/signing-config.test.ts`, `electron/__tests__/signing-dmg.test.ts`.

## Reading the gate

- `spctl` must say `accepted` and `source=Notarized Developer ID` on both app and DMG.
- `stapler validate` must say `The validate action worked!` on both. An unstapled
  artifact passes Gatekeeper online and fails offline — this is the only check
  that catches it.
- `TeamIdentifier=37YG3HV4BV` and `flags=0x10000(runtime)` (hardened runtime) on the app.
- The `.zip` is not separately signed; it contains the same stapled `.app`, which
  is what the updater extracts.

## When the build seems stalled

Two notary round trips happen per release (the app, then the DMG), normally a
few minutes each. Ask Apple rather than guessing:

```bash
xcrun notarytool history --keychain-profile omnifex-notary | head -12
```

`status: In Progress` means Apple still has it and there is nothing to fix.
The first-ever submission from a new team took ~90 minutes (2026-08-21); that
was one-time enrollment overhead.

## Identifiers

- Repo `greychrist/omnifex` (public, AGPL-3.0). Product OmniFex, publisher GreyChrist, LLC.
- Bundle ID `com.omnifex.app`; executable `OmniFex` (Swift) beside `omnifexd`
  (Node); installs to `/Applications/OmniFex.app`.
- Tag `v$SEMVER`. Artifacts `OmniFex-$SEMVER-arm64.dmg` and
  `OmniFex-darwin-arm64-$SEMVER.zip`; `macos/Sources/OmniFexCore/Updater.swift`
  parses the version from the ZIP name (`OmniFex-darwin-arm64-X.Y.Z.zip`), as
  did the Electron app's updater, so a rename must change both.
- Release cost: 0 CI minutes (all local); notarization is included in the
  Developer Program; each release ≈ 250 MB of GitHub asset storage.

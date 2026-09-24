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
- **Entitlements:** `signing/entitlements.plist` and
  `signing/entitlements.inherit.plist`. Both are required — the JIT-ing renderer
  is a helper process and reads the inherit file.
- **DMG:** signed / notarized / stapled by the `postMake` hook in
  `forge.config.ts` (`signing/dmg.ts`), because `maker-dmg` wraps the already
  notarized `.app` in a fresh container with no signature of its own.
- **Gate:** `OMNIFEX_NOTARIZE=1` is the only switch. Without it `npm run make`
  exits 0 and produces signed-but-never-notarized artifacts (`osxNotarize` and
  the DMG hook both no-op). Unit tests: `electron/__tests__/signing-config.test.ts`,
  `electron/__tests__/signing-dmg.test.ts`.

## Reading the gate

- `spctl` must say `accepted` and `source=Notarized Developer ID` on both app and DMG.
- `stapler validate` must say `The validate action worked!` on both. An unstapled
  artifact passes Gatekeeper online and fails offline — this is the only check
  that catches it.
- `TeamIdentifier=37YG3HV4BV` and `flags=0x10000(runtime)` (hardened runtime) on the app.
- The `.zip` is not separately signed; it contains the same stapled `.app`, which
  is what the updater extracts.

## When the build seems stalled

Two notary round trips happen per release (app during packaging, DMG in
`postMake`), normally a few minutes each. Ask Apple rather than guessing:

```bash
xcrun notarytool history --keychain-profile omnifex-notary | head -12
```

`status: In Progress` means Apple still has it and there is nothing to fix.
The first-ever submission from a new team took ~90 minutes (2026-08-21); that
was one-time enrollment overhead.

## Identifiers

- Repo `greychrist/omnifex` (public, AGPL-3.0). Product OmniFex, publisher GreyChrist, LLC.
- Bundle ID `com.omnifex.app`; executable `omnifex`; installs to `/Applications/OmniFex.app`.
- Tag `v$SEMVER`. Artifacts `OmniFex-$SEMVER-arm64.dmg` and
  `OmniFex-darwin-arm64-$SEMVER.zip`; `electron/services/updater.ts` parses the
  version from the ZIP name with `/^OmniFex-darwin-arm64-(\d+\.\d+\.\d+)\.zip$/`,
  so a rename must change both.
- Release cost: 0 CI minutes (all local); notarization is included in the
  Developer Program; each release ≈ 250 MB of GitHub asset storage.

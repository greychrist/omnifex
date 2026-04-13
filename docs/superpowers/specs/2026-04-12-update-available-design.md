# Update Available Feature

## Summary

On launch, the app checks GitHub releases for a newer version. If found, a highlighted button appears in the titlebar. Clicking it downloads the DMG directly with progress, then offers to open it. Also removes the duplicate macOS traffic light buttons from the custom titlebar.

## Decisions

- **Update check:** GitHub Releases API, on launch only
- **Download:** Stream DMG to Downloads folder with progress events
- **Install:** Open the downloaded DMG via `shell.openPath` (mounts in Finder)
- **No code signing required** -- this approach works unsigned
- **No `electron-updater`** -- can graduate to it later when signing is in place

## Backend

### New service: `electron/services/updater.ts`

Factory function `createUpdaterService()` with three methods:

**`checkForUpdate(): Promise<UpdateInfo | null>`**
- Fetches `https://api.github.com/repos/greychrist/GreyChrist/releases` (list endpoint, not `/latest`, because releases may be drafts)
- Finds the first non-draft, non-prerelease release (or falls back to the first release with assets)
- Extracts the version from the tag name (strips leading `v`)
- Compares against `app.getVersion()` using semver
- Returns `{ available: true, version, downloadUrl, releaseUrl, releaseNotes }` if newer, or `{ available: false, version: currentVersion, ... }` otherwise
- Returns `null` on network/parse errors (silent failure -- no update button shown)

**`downloadUpdate(url: string, sendProgress: (data: ProgressData) => void): Promise<string>`**
- Streams the asset to `<app.getPath('downloads')>/GreyChrist-<version>.dmg`
- Emits progress callbacks: `{ percent: number, bytesDownloaded: number, totalBytes: number }`
- Returns the absolute file path on completion
- Throws on failure (network error, disk full, etc.)

**`openUpdate(filePath: string): Promise<void>`**
- Calls `shell.openPath(filePath)` to mount the DMG in Finder

### Types

```typescript
interface UpdateInfo {
  available: boolean;
  version: string;
  downloadUrl: string;    // Direct URL to the DMG asset
  releaseUrl: string;     // GitHub release page URL (fallback)
  releaseNotes?: string;
}

interface ProgressData {
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
}
```

### IPC channels

| Channel | Direction | Payload |
|---------|-----------|---------|
| `updater:check` | invoke | returns `UpdateInfo \| null` |
| `updater:download` | invoke | `{ url: string }` -- starts download, returns file path |
| `updater:progress` | event (main->renderer) | `ProgressData` |
| `updater:open` | invoke | `{ filePath: string }` -- opens the DMG |

Add `updater:check`, `updater:download`, `updater:open` to the preload invoke allow-list.
Add `updater-` to the preload event prefix allow-list.

### Asset selection

The DMG asset is identified by matching the filename pattern `GreyChrist-*-arm64.dmg` (or the platform-appropriate pattern). If no DMG is found, fall back to the ZIP. If no matching asset exists, `downloadUrl` is empty and the button links to `releaseUrl` instead.

## Frontend

### CustomTitlebar changes

**Remove duplicate traffic lights:**
Delete the red/yellow/green close/minimize/maximize buttons (the `<div>` containing them in the left side of the titlebar). Electron's native frame already provides these.

**Add update button:**
New state managed in `CustomTitlebar.tsx`:

```typescript
type UpdateState =
  | { status: 'idle' }                          // no update / checking
  | { status: 'available'; info: UpdateInfo }   // button visible
  | { status: 'downloading'; percent: number }  // progress shown
  | { status: 'ready'; filePath: string }        // install button
  | { status: 'error'; message: string };        // download failed
```

On mount, call `updater:check`. If `available`, transition to `'available'` state.

### Button placement

In the titlebar right section, the button appears to the left of the Agents button:

```
[Update Available!] | [Agents] | [Usage] | separator | [Settings] | [More]
```

### Button states

| State | Icon | Text | Style |
|-------|------|------|-------|
| `available` | `Download` (lucide) | "Update Available!" | Highlighted -- accent/primary background with subtle pulse animation, white text |
| `downloading` | `Loader2` (spinning) | "Downloading... X%" | Same accent background, no pulse |
| `ready` | `CheckCircle` | "Install Update" | Green background |
| `error` | `AlertCircle` | "Retry" | Red/destructive style |

- Icon is on the left, text on the right (standard button layout)
- Tooltip shows the version number (e.g., "v0.4.0 available")
- The button is slightly larger than the icon-only titlebar buttons to accommodate the text

### Click behavior

| State | Action |
|-------|--------|
| `available` | Start download, transition to `downloading` |
| `downloading` | No-op (or show "downloading..." tooltip) |
| `ready` | Call `updater:open`, transition back to `ready` (button stays until app restarts) |
| `error` | Retry download |

### Listen for progress

Subscribe to `updater:progress` events during the download to update the percentage display.

## Cleanup

### Remove duplicate traffic light buttons

The `CustomTitlebar.tsx` component renders its own close/minimize/maximize buttons (red/yellow/green circles, lines 74-117). These duplicate the native Electron frame buttons. Remove them entirely -- keep only the right-side navigation icons.

The left side of the titlebar becomes empty drag space (or can show the app title if desired later).

## Testing

### Backend (`electron/__tests__/updater.test.ts`)

- `checkForUpdate()` returns `available: true` when remote version is newer
- `checkForUpdate()` returns `available: false` when versions match
- `checkForUpdate()` returns `null` on network error
- `checkForUpdate()` skips draft/prerelease entries
- `checkForUpdate()` selects the correct DMG asset by platform
- `downloadUpdate()` streams to the expected path and reports progress
- `downloadUpdate()` throws on network failure
- Mock `fetch` for all tests (no real network calls)

### Frontend

- Verify the update button appears/hides based on state
- Verify state transitions (available -> downloading -> ready)
- Manual testing: build a release with a bumped version, install the old version, confirm the button appears and download works

## Out of scope

- Auto-update (restart + replace) -- requires code signing
- Windows/Linux asset selection -- macOS only for now
- Update check frequency / periodic background checks
- Release notes display in-app
- Rollback / version pinning

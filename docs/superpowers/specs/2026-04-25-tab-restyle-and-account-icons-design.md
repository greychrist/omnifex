# Tab Restyle + Account Icons — Design

**Date:** 2026-04-25
**Status:** Approved scope, pre-implementation

## Goal

Restyle the main top-of-window tab strip to a shadcn-aesthetic (active tab as a 1px outlined pill, no dividers, rounded corners, no bottom underline) while keeping every current affordance — type icons, status indicators, account signal, drag-to-reorder, hover-revealed close, overflow scroll, keyboard shortcuts.

In support of that restyle, replace the current text account-pill (e.g. "work", "personal") with a compact tinted icon-chip in the account's color. This requires a new user-pickable icon per account.

## Why

- Current tab style is browser-style with a bottom-underline active state, square corners, and visible dividers. Greg prefers the shadcn pill aesthetic.
- The text-based account badge consumes horizontal real estate inside an already-constrained 120-220px tab; an 18px icon-chip carries the same identity signal in ~⅓ the width.
- Accounts already have user-settable colors. Adding a user-settable icon completes the per-account branding the chip needs.

## Surfaces affected

1. **Tab strip** (`src/components/TabManager.tsx`) — visual reskin only; behavior preserved.
2. **Account badge** (`src/components/AccountBadge.tsx`) — new compact icon-only variant alongside the existing full-text variant.
3. **AccountSettings** (`src/components/AccountSettings.tsx`) — add icon picker; upgrade color picker from native `<input type="color">` to a swatch grid for visual consistency.
4. **Account model** — add `icon` column.

Out of scope: secondary/inner tab UIs in settings panels (option B/C in the brainstorm). This is a surgical change to the main strip + the AccountBadge surface that flows from it.

## Visual spec — tab strip

### Layout

Order inside each tab (left → right): `type-icon · title · account-chip · status · close`.

Strip: 36px tall, 8px horizontal padding, 4px gap between tabs.

Tab: 26px tall, `min-width: 120px`, `max-width: 220px`, 6px border-radius, padding `5px 10px`, 7px internal gap.

### States

| State | Treatment |
|---|---|
| Inactive | `color: muted-foreground`, transparent background, no border |
| Inactive hover | text lifts to `foreground`, `bg: rgba(255,255,255,0.03)` |
| Active | text `foreground`, `box-shadow: inset 0 0 0 1px border`, slight tint background |
| Dragging | active styling + slight elevation (`shadow-sm`) — keep current framer-motion behavior |

No bottom underline. No `border-r` divider between tabs.

### Sub-elements

- **Type icon**: 13px, `opacity: 0.65` inactive, `1.0` active. Same Lucide icon mapping as today.
- **Title**: 12.5px, `font-weight: 500`, truncate with ellipsis, `flex: 1`.
- **Account chip**: 18×18px, 4px radius, tinted background + 1px inset border in the account color, Lucide icon at 11px stroke-width 2.2 inside. Tooltip on hover shows the account name. Hidden if the tab has no associated account.
- **Status**: fixed 14px slot. Spinner (running), pulsing green dot (unread result), AlertCircle (error). Empty when none.
- **Close**: 14×14px, hidden by default, `opacity: 0.5` on hover or active, `opacity: 1` + red tint on direct hover.

### Preserved behavior

- Drag-to-reorder via `framer-motion` Reorder
- Horizontal scroll when overflow
- "+" button at the right end
- All existing keyboard shortcuts
- Status priority order (running > error > unread > unsaved > none)

## Visual spec — AccountSettings

### Color picker upgrade

Replace `<input type="color">` with a 9-swatch grid (red, amber, lime, emerald, cyan, blue, violet, pink, gray). Selected swatch shown with a 2px white inset border. Swatches are 22×22px, 4px radius.

(Spec note: swatch palette can iterate; lock final hex values during implementation.)

### Icon picker

Lucide icon grid below the color row, 10 columns wide, 24px tiles, 4px radius. Selected tile shown with a tinted background in the account's color + inset border. Hover preview shows the icon name (existing `TooltipSimple` pattern from KindEditor).

Curated list (~30-50 icons) suited for account branding: User, Briefcase, Building, Home, Star, Heart, Rocket, Flag, Shield, Crown, Diamond, Coffee, Code, Terminal, GitBranch, Package, Wrench, Compass, Globe, Zap, Sparkles, Bot, MessageCircle, Wallet, CreditCard, Bookmark, Tag, Palette, Music, Camera, Gamepad, Anchor, Mountain, Tree, Sun, Moon, Cloud, etc.

(Final list locked at implementation; pattern matches the agent icon picker and Kind Editor.)

### Live preview

Below the pickers: a compact preview showing the account chip + name as it will appear in tabs. Updates live as color/icon change.

## Data model

```sql
ALTER TABLE accounts ADD COLUMN icon TEXT;
```

Nullable. Renderers fall back to `User` (Lucide) when null.

### Migration

Standard idempotent migration in `electron/services/database.ts`:

```ts
const cols = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
if (!cols.some(c => c.name === 'icon')) {
  db.prepare("ALTER TABLE accounts ADD COLUMN icon TEXT").run();
}
```

No backfill — null stays null and the renderer handles the default.

### Type changes

```ts
// electron/services/accounts.ts
interface Account {
  // ... existing fields
  color: string | null;
  icon: string | null;  // NEW
}

createAccount(name, configDir, isDefault, accountType, color?, icon?)
updateAccount(id, name, configDir, isDefault, accountType, color?, icon?)
```

Forwarded through `electron/ipc/handlers.ts` adapters (accept both `icon` and `account_icon` if needed for symmetry with existing camelCase/snake_case tolerance, otherwise `icon`).

Renderer-side: `src/lib/api.ts` extends the typed wrappers; `src/contexts/AccountsContext.tsx` already exposes the full account object so `icon` will be available without refactor.

## Components

### `AccountBadge` — extend, don't fork

Add a `variant?: 'full' | 'compact'` prop (default `full`).

- `full`: existing text badge with name and color tint. Used in AccountSettings list, project picker, account-test result, etc.
- `compact`: 18×18 chip with the account's icon, color-tinted, tooltip on hover.

Both share the color-tinting logic. Compact variant pulls icon from `account.icon` (default `User`).

### `TabManager` — reskin in place

Modify `src/components/TabManager.tsx` directly. No new component. Tailwind class changes per the visual spec; chip render swaps `<AccountBadge name={...} />` → `<AccountBadge name={...} icon={...} color={...} variant="compact" />`.

### `AccountSettings` — extend

Add a swatch-grid color picker component and a Lucide icon picker. The icon picker mirrors the existing agent icon picker pattern (likely already abstractable; if so, factor a small shared `<LucideIconPicker />` for reuse — only worth it if both pickers share enough markup).

## Build sequence

The work falls into three independent layers; build bottom-up so each layer can land + verify before the next.

1. **Schema + service** (TDD)
   - Migration in `database.ts`
   - `Account.icon` field through `accounts.ts` create/update + getters
   - IPC adapters
   - Tests in `electron/__tests__/accounts.test.ts` cover create-with-icon, update-icon, migration idempotency
   - Verification: `npm run check && npm test`

2. **AccountBadge compact variant + AccountSettings pickers**
   - Add `variant="compact"` to `AccountBadge`
   - Add icon picker UI to `AccountSettings`
   - Swap color input for swatch grid
   - Live preview wired up
   - Verification: `npm run check && npm run build`; manual UI smoke test

3. **TabManager reskin**
   - Tailwind class changes per visual spec
   - Swap to compact AccountBadge
   - Snapshot test for new structure (optional — current TabManager has no tests)
   - Verification: `npm run check && npm run build`; manual UI smoke test of tab states (active, hover, dragging, status indicators, overflow scroll, keyboard shortcuts)

Each layer is a separate commit.

## Testing

- **Service**: extend `electron/__tests__/accounts.test.ts` with icon round-trip + migration idempotency cases.
- **Visual**: no new automated tests for TabManager — current TabManager has none, and snapshot tests on heavy-Tailwind components add maintenance drag without proportional value. Manual smoke test covers it.
- **Coverage gate**: `npm run test:coverage` for the service layer change.

## Migration / fallback

- Accounts without an icon render the `User` Lucide icon. Always set, no breakage.
- Default chip color when `account.color` is null: existing fallback in `AccountBadge` (gray-tinted).
- The migration is additive and idempotent; no rollback path needed.

## Open questions deferred to implementation

- Final palette hex values for the swatch grid (9 colors).
- Final Lucide icon list for the picker (30-50 icons).
- Whether to factor `<LucideIconPicker />` as a shared component with the agent picker, or keep them separate. Decision criterion: factor only if ≥15 lines of duplicated structure.
- Whether the swatch-grid color picker also gets a "custom hex" escape hatch (matches today's native picker capability). Lean toward yes, low cost.

These don't affect the architecture or scope; they're locked at write-time during the build.

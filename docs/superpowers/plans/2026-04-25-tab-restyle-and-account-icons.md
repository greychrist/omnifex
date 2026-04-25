# Tab Restyle + Account Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the main top-of-window tab strip to a shadcn-aesthetic (1px outlined active pill, no dividers, rounded), keep all current affordances, and replace the text account-pill with a compact tinted icon-chip that uses a new user-pickable per-account icon.

**Architecture:** Bottom-up in three layers. Layer 1 — schema migration adds `accounts.icon` column; service + IPC + renderer API extended to thread it through. Layer 2 — `AccountBadge` grows a `variant="compact"` mode and `AccountSettings` gets an icon picker + swatch-grid color picker. Layer 3 — `TabManager.tsx` Tailwind reskin and swap to the compact badge. Each task is independently verifiable.

**Tech Stack:** Electron + better-sqlite3 (main), React 18 + Tailwind v4 + Radix + Lucide + framer-motion (renderer), Vitest. The existing `IconPicker` component (`src/components/IconPicker.tsx`) is reused as-is — it already exports `ICON_MAP` keyed by kebab-case Lucide names.

**Spec:** `docs/superpowers/specs/2026-04-25-tab-restyle-and-account-icons-design.md`

---

## File map

**Modify:**
- `electron/services/database.ts` — add migration v2 (`accounts.icon` column)
- `electron/services/accounts.ts` — extend `Account` type, `AccountRow` type, `rowToAccount`, `createAccount`, `updateAccount`, `AccountsService` interface
- `electron/main.ts` — extend `accounts.create` / `accounts.update` adapters to forward `icon`
- `electron/__tests__/accounts.test.ts` — round-trip + migration tests
- `electron/__tests__/database.test.ts` — migration v2 idempotency test (if file exists; else inline in accounts test)
- `src/lib/api.ts` — extend `createAccount` / `updateAccount` wrappers + `Account` type if defined here
- `src/types/account.ts` (or wherever `Account` is declared on the renderer) — add `icon` field
- `src/components/AccountBadge.tsx` — add `variant`, `icon` props; render compact chip
- `src/components/AccountSettings.tsx` — replace native color input with swatch grid; add IconPicker; live preview; thread `icon` through create/edit state
- `src/components/TabManager.tsx` — Tailwind class changes per visual spec; switch to compact AccountBadge

**No changes needed:**
- `electron/preload.ts` — `create_account` / `update_account` channels already in allow-list (verified)

---

## Task 1: Schema migration (`accounts.icon` column)

**Files:**
- Modify: `electron/services/database.ts:40-51`
- Test: `electron/__tests__/database.test.ts` (extend) or `electron/__tests__/accounts.test.ts`

- [ ] **Step 1.1: Locate the migration list and add a failing test**

Open `electron/__tests__/database.test.ts`. If it doesn't exist, create it with this content. If it does, add the test inside the existing `describe`.

```typescript
// electron/__tests__/database.test.ts
import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../services/database';

describe('migrations', () => {
  it('migration v2 adds an icon column to accounts', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT 0,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    runMigrations(db);

    const cols = db.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.some((c) => c.name === 'icon')).toBe(true);
  });

  it('migration v2 is idempotent (running twice does not throw)', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT 0,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    expect(() => {
      runMigrations(db);
      runMigrations(db);
    }).not.toThrow();

    const cols = db.pragma('table_info(accounts)') as { name: string }[];
    expect(cols.filter((c) => c.name === 'icon')).toHaveLength(1);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

```bash
npm test -- electron/__tests__/database.test.ts
```

Expected: both tests fail. The first fails on `expect(...).toBe(true)` because the icon column doesn't exist; the second fails for the same reason.

- [ ] **Step 1.3: Add migration v2 to `electron/services/database.ts`**

Edit the `migrations` array (around line 40-51) to add a v2 entry. Final state:

```typescript
const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add color column to accounts',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'color')) {
        db.exec('ALTER TABLE accounts ADD COLUMN color TEXT');
      }
    },
  },
  {
    version: 2,
    description: 'Add icon column to accounts',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'icon')) {
        db.exec('ALTER TABLE accounts ADD COLUMN icon TEXT');
      }
    },
  },
];
```

Also extend the inline `accounts` table definition in `initSchema` (around line 194-204) so fresh installs get the column without relying on the migration:

```typescript
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      config_dir TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT 0,
      account_type TEXT NOT NULL DEFAULT 'pro',
      color TEXT,
      icon TEXT,
      claude_binary TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
```

- [ ] **Step 1.4: Run the migration tests — should pass**

```bash
npm test -- electron/__tests__/database.test.ts
```

Expected: both tests pass.

- [ ] **Step 1.5: Run the full electron test suite — should still pass**

```bash
npm test
```

Expected: all tests pass (no regressions). The pretest hook will rebuild better-sqlite3 first; that's fine.

- [ ] **Step 1.6: Commit**

```bash
git add electron/services/database.ts electron/__tests__/database.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration v2 adds accounts.icon column

Idempotent ALTER TABLE migration plus the new column in initSchema for
fresh installs. Renderer-side default ('user') applied later when the
field is null.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Service layer — thread `icon` through accounts.ts

**Files:**
- Modify: `electron/services/accounts.ts:10-19, 41-69, 75-84, 98-109, 148-188`
- Test: `electron/__tests__/accounts.test.ts`

- [ ] **Step 2.1: Add failing tests for icon round-trip**

Append to `electron/__tests__/accounts.test.ts` inside the existing `describe('accounts service', ...)` block, alongside the existing CRUD tests:

```typescript
  it('persists icon on create and reads it back via listAccounts', () => {
    accounts.createAccount('Personal', '/home/user/.claude', false, 'pro', '#a78bfa', 'user');
    const list = accounts.listAccounts();
    expect(list[0].icon).toBe('user');
  });

  it('updates icon via updateAccount', () => {
    const acct = accounts.createAccount('Work', '/home/user/.claude-work', false, 'team', '#f59e0b', 'briefcase');
    accounts.updateAccount(acct.id, 'Work', '/home/user/.claude-work', 'team', '#f59e0b', 'rocket');
    const list = accounts.listAccounts();
    expect(list[0].icon).toBe('rocket');
  });

  it('icon is null when not provided on create', () => {
    accounts.createAccount('NoIcon', '/home/user/.claude', false, 'pro');
    const list = accounts.listAccounts();
    expect(list[0].icon).toBeNull();
  });
```

- [ ] **Step 2.2: Run the new tests — should fail**

```bash
npm test -- electron/__tests__/accounts.test.ts -t 'icon'
```

Expected: TypeScript compile errors (the 6th positional arg to `createAccount` doesn't exist) plus runtime failures.

- [ ] **Step 2.3: Extend `Account` interface and `AccountRow`**

Edit `electron/services/accounts.ts`. Replace the existing `Account` interface (lines 10-19):

```typescript
export interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
  account_type: string;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}
```

Replace `AccountRow` (lines 75-84):

```typescript
interface AccountRow {
  id: number;
  name: string;
  config_dir: string;
  is_default: number;
  account_type: string;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2.4: Update `rowToAccount`**

Replace `rowToAccount` (lines 98-109):

```typescript
function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    config_dir: row.config_dir,
    is_default: row.is_default !== 0,
    account_type: row.account_type,
    color: row.color,
    icon: row.icon,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
```

- [ ] **Step 2.5: Extend the `AccountsService` interface**

Replace the `createAccount` and `updateAccount` declarations (lines 43-56):

```typescript
  createAccount(
    name: string,
    configDir: string,
    isDefault: boolean,
    accountType?: string,
    color?: string,
    icon?: string,
  ): Account;
  updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
  ): void;
```

- [ ] **Step 2.6: Update `createAccount` implementation**

Replace lines 148-171:

```typescript
  function createAccount(
    name: string,
    configDir: string,
    isDefault: boolean,
    accountType = 'pro',
    color?: string,
    icon?: string,
  ): Account {
    if (isDefault) {
      raw.prepare('UPDATE accounts SET is_default = 0').run();
    }

    const info = raw
      .prepare(
        `INSERT INTO accounts (name, config_dir, is_default, account_type, color, icon)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, configDir, isDefault ? 1 : 0, accountType, color ?? null, icon ?? null);

    const row = raw
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(info.lastInsertRowid) as AccountRow;

    return rowToAccount(row);
  }
```

- [ ] **Step 2.7: Update `updateAccount` implementation**

Replace lines 173-188:

```typescript
  function updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
  ): void {
    raw
      .prepare(
        `UPDATE accounts
         SET name = ?, config_dir = ?, account_type = COALESCE(?, account_type),
             color = ?, icon = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(name, configDir, accountType ?? null, color ?? null, icon ?? null, id);
  }
```

- [ ] **Step 2.8: Run accounts tests — should pass**

```bash
npm test -- electron/__tests__/accounts.test.ts
```

Expected: all tests pass, including the three new icon tests.

- [ ] **Step 2.9: Run TypeScript check**

```bash
npm run check
```

Expected: passes. (Confirms `Account` type changes don't break callers — there should be none yet because no caller reads `account.icon`.)

- [ ] **Step 2.10: Commit**

```bash
git add electron/services/accounts.ts electron/__tests__/accounts.test.ts
git commit -m "$(cat <<'EOF'
feat(accounts): thread icon through service layer

Add icon: string | null to Account; extend createAccount/updateAccount
to accept an optional icon argument; round-trip via SQLite. IPC adapters
wired in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: IPC + renderer API plumbing

**Files:**
- Modify: `electron/main.ts:454-466`
- Modify: `src/lib/api.ts:2048-2060`
- Modify: any renderer-side `Account` type if separate from the service type (search first)

- [ ] **Step 3.1: Find any renderer-side Account type definition**

```bash
grep -rn "interface Account\b\|type Account\b" /Users/gregorychristie/Repos/personal/greychrist/src --include='*.ts' --include='*.tsx'
```

Expected: locate every renderer-side declaration of `Account`. Each one needs an `icon: string | null` field added.

- [ ] **Step 3.2: Add `icon` to every renderer-side `Account` type found in 3.1**

For each file found, add the field. Example shape:

```typescript
export interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
  account_type: string;
  color: string | null;
  icon: string | null;  // ADD THIS
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3.3: Update IPC adapters in `electron/main.ts`**

Replace lines 456-465 of `electron/main.ts`:

```typescript
      create: (data: any) =>
        accountsService.createAccount(
          data.name,
          data.configDir ?? data.config_dir,
          data.isDefault ?? data.is_default ?? false,
          data.accountType ?? data.account_type,
          data.color,
          data.icon,
        ),
      update: (_id: any, data: any) =>
        accountsService.updateAccount(
          data.id,
          data.name,
          data.configDir ?? data.config_dir,
          data.accountType ?? data.account_type,
          data.color,
          data.icon,
        ),
```

- [ ] **Step 3.4: Update `api.ts` wrappers**

Replace `createAccount` and `updateAccount` in `src/lib/api.ts` (lines 2048-2060):

```typescript
  async createAccount(
    name: string,
    configDir: string,
    isDefault: boolean,
    accountType?: string,
    color?: string,
    icon?: string,
  ): Promise<Account> {
    const params: Record<string, any> = { name, configDir, isDefault };
    if (accountType) params.accountType = accountType;
    if (color) params.color = color;
    if (icon) params.icon = icon;
    return apiCall<Account>('create_account', params);
  },

  async updateAccount(
    id: number,
    name: string,
    configDir: string,
    accountType?: string,
    color?: string,
    icon?: string,
  ): Promise<void> {
    const params: Record<string, any> = { id, name, configDir };
    if (accountType) params.accountType = accountType;
    if (color !== undefined) params.color = color;
    if (icon !== undefined) params.icon = icon;
    return apiCall<void>('update_account', params);
  },
```

- [ ] **Step 3.5: Run TypeScript check**

```bash
npm run check
```

Expected: passes. If a callsite breaks because the local `Account` type didn't get the `icon` field, fix that file (you may have missed one in step 3.1).

- [ ] **Step 3.6: Run full test suite**

```bash
npm test
```

Expected: passes.

- [ ] **Step 3.7: Commit**

```bash
git add electron/main.ts src/lib/api.ts $(git diff --name-only | grep -E '\.tsx?$')
git commit -m "$(cat <<'EOF'
feat(accounts): plumb icon through IPC and renderer API

main.ts adapters and api.ts wrappers now forward an optional icon. No UI
consumes it yet; that's next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `AccountBadge` compact variant

**Files:**
- Modify: `src/components/AccountBadge.tsx`

- [ ] **Step 4.1: Replace `AccountBadge` to support a compact icon-chip variant**

Full new contents of `src/components/AccountBadge.tsx`:

```typescript
import React from "react";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/contexts/AccountsContext";
import { ICON_MAP } from "./IconPicker";
import { User } from "lucide-react";

const FALLBACK_COLORS = [
  "bg-blue-500/20 text-blue-400 border-blue-500/30",
  "bg-purple-500/20 text-purple-400 border-purple-500/30",
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "bg-rose-500/20 text-rose-400 border-rose-500/30",
  "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
];

function getFallbackColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

interface AccountBadgeProps {
  name: string;
  color?: string | null;
  icon?: string | null;
  variant?: "full" | "compact";
  className?: string;
}

export const AccountBadge: React.FC<AccountBadgeProps> = ({
  name,
  color: colorProp,
  icon,
  variant = "full",
  className,
}) => {
  const { getColor } = useAccounts();
  const color = colorProp ?? getColor(name);

  if (variant === "compact") {
    const IconComponent = (icon && ICON_MAP[icon]) || User;
    if (color) {
      return (
        <span
          title={name}
          className={cn(
            "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
            className,
          )}
          style={{
            backgroundColor: `${color}2e`,
            color: color,
            boxShadow: `inset 0 0 0 1px ${color}4d`,
          }}
        >
          <IconComponent className="h-[11px] w-[11px]" strokeWidth={2.2} />
        </span>
      );
    }
    return (
      <span
        title={name}
        className={cn(
          "inline-flex items-center justify-center rounded h-[18px] w-[18px] flex-shrink-0",
          getFallbackColor(name),
          className,
        )}
      >
        <IconComponent className="h-[11px] w-[11px]" strokeWidth={2.2} />
      </span>
    );
  }

  if (color) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
          className,
        )}
        style={{
          backgroundColor: `${color}33`,
          color: color,
          borderColor: `${color}4d`,
        }}
      >
        {name}
      </span>
    );
  }

  const fallbackClass = getFallbackColor(name);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        fallbackClass,
        className,
      )}
    >
      {name}
    </span>
  );
};
```

- [ ] **Step 4.2: Run check + build**

```bash
npm run check && npm run build
```

Expected: both pass. No call sites are using the new `compact` variant yet so no behavior changes.

- [ ] **Step 4.3: Commit**

```bash
git add src/components/AccountBadge.tsx
git commit -m "$(cat <<'EOF'
feat(account-badge): add compact icon-chip variant

variant='compact' renders an 18x18 tinted square with the account's
Lucide icon (defaults to User when icon is null). Tooltip carries the
account name. variant='full' (default) preserves existing behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `AccountSettings` — swatch-grid color picker + icon picker

**Files:**
- Modify: `src/components/AccountSettings.tsx`

This task adds three things: a 9-swatch color grid replacing `<input type="color">`, an `IconPicker` button that surfaces the existing picker, and a live preview using `<AccountBadge variant="compact" />`. The new state plumbs through both the create form and the edit form.

- [ ] **Step 5.1: Add a `ColorSwatchGrid` helper component at the top of `AccountSettings.tsx`**

Insert after the existing imports, before the main `AccountSettings` component:

```typescript
const SWATCHES = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#a78bfa", // violet
  "#ec4899", // pink
  "#6b7280", // gray
];

interface ColorSwatchGridProps {
  value: string;
  onChange: (color: string) => void;
}

const ColorSwatchGrid: React.FC<ColorSwatchGridProps> = ({ value, onChange }) => {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SWATCHES.map((swatch) => (
        <button
          key={swatch}
          type="button"
          onClick={() => onChange(swatch)}
          className={cn(
            "w-[22px] h-[22px] rounded cursor-pointer transition-shadow",
            value.toLowerCase() === swatch.toLowerCase()
              ? "ring-2 ring-white ring-offset-0"
              : "ring-1 ring-white/10 hover:ring-white/30",
          )}
          style={{ backgroundColor: swatch }}
          aria-label={`Select color ${swatch}`}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-[22px] h-[22px] rounded cursor-pointer border border-border bg-transparent"
        title="Custom color"
      />
    </div>
  );
};
```

You'll need to import `cn` from `@/lib/utils` if not already imported in this file. Check the imports at the top.

- [ ] **Step 5.2: Add icon state + picker import to `AccountSettings`**

Add to the imports near the top of the file:

```typescript
import { IconPicker } from "./IconPicker";
import { AccountBadge } from "./AccountBadge";  // already imported — verify, don't duplicate
```

Find the existing edit-state hooks (around line 144-149) and add icon state. Locate this block:

```typescript
  const startEdit = (account: Account) => {
    setEditingId(account.id);
    setEditName(account.name);
    setEditDir(account.config_dir);
    setEditType(account.account_type);
    setEditColor(account.color || "#3b82f6");
  };
```

Add an `editIcon` state hook alongside the other `useState` declarations near the top of the component (search for `setEditColor` state declaration), e.g.:

```typescript
  const [editIcon, setEditIcon] = useState<string>("user");
  const [showEditIconPicker, setShowEditIconPicker] = useState(false);
  const [newIcon, setNewIcon] = useState<string>("user");
  const [showNewIconPicker, setShowNewIconPicker] = useState(false);
```

Update `startEdit` to seed `editIcon` from `account.icon`:

```typescript
  const startEdit = (account: Account) => {
    setEditingId(account.id);
    setEditName(account.name);
    setEditDir(account.config_dir);
    setEditType(account.account_type);
    setEditColor(account.color || "#3b82f6");
    setEditIcon(account.icon || "user");
  };
```

- [ ] **Step 5.3: Pass `icon` through `saveEdit` and `handleCreate`**

Find `saveEdit` (around line 156-165) and `handleCreate` (around line 167-180). Update both to pass icon to the API:

```typescript
  const saveEdit = async () => {
    if (editingId === null || !editName.trim() || !editDir.trim()) return;
    try {
      await api.updateAccount(editingId, editName.trim(), editDir.trim(), editType, editColor, editIcon);
      setEditingId(null);
      await loadData();
    } catch (error) {
      console.error("Failed to update account:", error);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newDir.trim()) return;
    try {
      await api.createAccount(newName.trim(), newDir.trim(), accounts.length === 0, newType, newColor, newIcon);
      setNewName("");
      setNewDir("");
      setNewType("pro");
      setNewColor("#3b82f6");
      setNewIcon("user");
      setShowAddAccount(false);
      await loadData();
    } catch (error) {
      console.error("Failed to create account:", error);
    }
  };
```

- [ ] **Step 5.4: Replace the native color input in the edit form with the swatch grid + icon picker + preview**

Find the edit-mode block (around line 238-246):

```typescript
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">Color</label>
                  <input
                    type="color"
                    value={editColor}
                    onChange={(e) => setEditColor(e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer border border-border bg-transparent"
                  />
                </div>
```

Replace it with:

```typescript
                <div className="space-y-2">
                  <div className="flex items-start gap-3">
                    <label className="text-xs text-muted-foreground w-14 mt-1">Color</label>
                    <ColorSwatchGrid value={editColor} onChange={setEditColor} />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-muted-foreground w-14">Icon</label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setShowEditIconPicker(true)}
                      className="h-8 px-2"
                    >
                      {(() => {
                        const IconComponent = ICON_MAP[editIcon] || ICON_MAP.user;
                        return IconComponent ? <IconComponent className="w-4 h-4" /> : null;
                      })()}
                      <span className="ml-2 text-xs">{editIcon}</span>
                    </Button>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="text-xs text-muted-foreground w-14">Preview</label>
                    <div className="flex items-center gap-2">
                      <AccountBadge
                        name={editName || "Account"}
                        color={editColor}
                        icon={editIcon}
                        variant="compact"
                      />
                      <span className="text-xs text-foreground">{editName || "Account"}</span>
                    </div>
                  </div>
                </div>
```

You'll need to add `ICON_MAP` to the imports if not already present:

```typescript
import { IconPicker, ICON_MAP } from "./IconPicker";
```

- [ ] **Step 5.5: Replace the native color input in the create form similarly**

Find the create form's color input (around line 316). Apply the same pattern: swap to `<ColorSwatchGrid value={newColor} onChange={setNewColor} />` and add an icon-picker button + live preview using `newIcon` / `setNewIcon` / `setShowNewIconPicker`. The exact line numbers will depend on what's there; the structure mirrors Step 5.4 with `new*` variables instead of `edit*`.

- [ ] **Step 5.6: Mount both `IconPicker` modals near the bottom of the component (just before the closing `</div>` of the top-level wrapper)**

```typescript
      <IconPicker
        value={editIcon}
        onSelect={(name) => {
          setEditIcon(name);
          setShowEditIconPicker(false);
        }}
        isOpen={showEditIconPicker}
        onClose={() => setShowEditIconPicker(false)}
      />
      <IconPicker
        value={newIcon}
        onSelect={(name) => {
          setNewIcon(name);
          setShowNewIconPicker(false);
        }}
        isOpen={showNewIconPicker}
        onClose={() => setShowNewIconPicker(false)}
      />
```

- [ ] **Step 5.7: Run check + build**

```bash
npm run check && npm run build
```

Expected: passes.

- [ ] **Step 5.8: Manual smoke test**

```bash
npm run rebuild:electron && npm start
```

Verify:
- Open Settings → Accounts. Edit an existing account: swatch grid renders, clicking a swatch updates the color, icon picker opens, picking an icon updates the chip preview, save persists. Reload the app — color and icon survive.
- Add a new account: same behavior, defaults to icon `user` and color `#3b82f6`.

If anything is broken, fix it before committing. Otherwise:

- [ ] **Step 5.9: Commit**

```bash
git add src/components/AccountSettings.tsx
git commit -m "$(cat <<'EOF'
feat(account-settings): icon picker + swatch-grid color picker

Replaces the native <input type='color'> with a 9-swatch grid (custom
hex still available via the trailing native input). Adds an IconPicker
button for selecting the per-account Lucide icon. Live preview uses the
new compact AccountBadge variant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `TabManager` reskin + compact AccountBadge

**Files:**
- Modify: `src/components/TabManager.tsx:60-146`

- [ ] **Step 6.1: Update the icon import to add `Loader2` (we'll keep the existing Spinner) — and verify the AccountBadge import is in place**

Existing imports at the top of `TabManager.tsx` already include `AccountBadge`. No new icon imports needed unless the spinner replacement changes (it doesn't).

- [ ] **Step 6.2: Replace the `Reorder.Item` body to apply the new visual style and use the compact AccountBadge**

Find the JSX block starting at line 72 (`<Reorder.Item ...>`) and ending at line 144 (the closing `</Reorder.Item>`). Replace with:

```tsx
    <Reorder.Item
      value={tab}
      id={tab.id}
      dragListener={true}
      transition={{ duration: 0.1 }}
      className={cn(
        "relative flex items-center gap-[7px] text-[12.5px] cursor-pointer select-none group",
        "transition-all duration-100",
        "rounded-md h-[26px] px-[10px]",
        "min-w-[120px] max-w-[220px]",
        isActive
          ? "text-foreground bg-card shadow-[inset_0_0_0_1px_hsl(var(--border))]"
          : "text-muted-foreground hover:text-foreground hover:bg-white/5",
        isDragging && "shadow-sm",
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onClick(tab.id)}
      onDragStart={() => setDraggedTabId?.(tab.id)}
      onDragEnd={() => setDraggedTabId?.(null)}
    >
      {/* Type icon */}
      <div className="flex-shrink-0">
        <Icon className={cn("w-[13px] h-[13px]", isActive ? "opacity-100" : "opacity-65")} />
      </div>

      {/* Title */}
      <span className="flex-1 truncate font-medium min-w-0">
        {tab.title}
      </span>

      {/* Account chip (compact) */}
      {tab.accountName && (
        <AccountBadge
          name={tab.accountName}
          icon={tab.accountIcon}
          color={tab.accountColor}
          variant="compact"
        />
      )}

      {/* Status indicator (fixed slot) */}
      <div className="flex items-center justify-center w-[14px] flex-shrink-0">
        {statusIcon}
        {tab.hasUnsavedChanges && !statusIcon && (
          <span
            className="w-1.5 h-1.5 bg-primary rounded-full"
            title="Unsaved changes"
          />
        )}
      </div>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        className={cn(
          "flex-shrink-0 w-[14px] h-[14px] flex items-center justify-center rounded-sm",
          "transition-all duration-100 hover:bg-destructive/20 hover:text-destructive",
          "focus:outline-none focus:ring-1 focus:ring-destructive/50",
          isHovered || isActive ? "opacity-50" : "opacity-0",
          "hover:opacity-100",
        )}
        title={`Close ${tab.title}`}
        tabIndex={-1}
      >
        <X className="w-3 h-3" />
      </button>
    </Reorder.Item>
```

Key changes from the previous version:
- Removed `border-r border-border/20` divider, the `before:` underline pseudo, and the `bg-muted/40` hover treatment.
- Active state: `bg-card` + `shadow-[inset_0_0_0_1px_hsl(var(--border))]` instead of bottom underline.
- Tab is `rounded-md`, height `26px`, padding `10px`.
- Removed the old text `<AccountBadge name={tab.accountName} ... />` and the inline `text-[9px]` styling.

- [ ] **Step 6.3: Update the strip container to add 4px gap and 8px horizontal padding**

Search for the JSX rendering the `Reorder.Group` or the wrapper `div` that holds the tabs. The current TabManager wraps tabs in a flex row. Add `gap-1` and adjust padding to match the spec:

```tsx
<Reorder.Group
  axis="x"
  values={tabs}
  onReorder={reorderTabs}
  className="flex items-center gap-1 px-2 h-9 ..."  // existing classes preserved; just add gap-1, px-2, h-9
  ...
>
```

(If the existing classes already set width/overflow/etc, keep those. Only add `gap-1`, `px-2`, and adjust the strip height to `h-9` — 36px.)

- [ ] **Step 6.4: Make sure the `Tab` type carries `accountIcon` and `accountColor`**

The compact `AccountBadge` reads `tab.accountIcon` and `tab.accountColor`. Find the `Tab` interface in `src/contexts/TabContext.tsx` and confirm those fields exist. If they don't, add them:

```typescript
export interface Tab {
  // ... existing fields
  accountName?: string;
  accountColor?: string | null;
  accountIcon?: string | null;
}
```

Then find every place that builds a Tab with an `accountName` and ensure `accountColor` and `accountIcon` are also threaded through (search for `accountName:` to find the call sites). Pull these from the `Account` object that's already in scope at each callsite.

- [ ] **Step 6.5: Run check + build**

```bash
npm run check && npm run build
```

Expected: passes.

- [ ] **Step 6.6: Manual smoke test**

```bash
npm run rebuild:electron && npm start
```

Verify against the visual spec:
- Active tab is a rounded outlined pill with `bg-card`, no bottom underline.
- Inactive tabs are dim text, hover lifts text + adds subtle bg.
- No vertical divider between tabs; small gap instead.
- Account chip appears between title and status, in the account's color, with the picked icon.
- Tooltip on the chip shows the account name.
- Status spinner / unread dot / error icon still appear in their slot.
- Close button hidden by default, visible on hover or for the active tab.
- Drag-to-reorder still works smoothly.
- Horizontal scroll still kicks in when many tabs are open.
- Keyboard shortcuts (Cmd-T, Cmd-W, Cmd-Tab, Cmd-1..9) still work.

If any of those is broken, fix before committing.

- [ ] **Step 6.7: Commit**

```bash
git add src/components/TabManager.tsx src/contexts/TabContext.tsx $(git diff --name-only | grep -E '\.tsx?$')
git commit -m "$(cat <<'EOF'
feat(tabs): shadcn-aesthetic reskin with compact account chip

Active tab is a 1px outlined rounded pill instead of a bottom underline;
dividers between tabs replaced by a small gap; rounded corners; height
bumped to 36px. Account text-pill replaced by AccountBadge variant=compact
(an 18x18 icon chip in the account's color). All existing affordances —
type icons, status indicator, drag-to-reorder, hover close, overflow
scroll, keyboard shortcuts — preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification gate

- [ ] **Step 7.1: Full verification**

```bash
npm run check && npm test && npm run build
```

Expected: all three pass.

- [ ] **Step 7.2: Rebuild Electron ABI**

```bash
npm run rebuild:electron
```

Expected: `verified: native modules at NMV 145 (Electron ABI)`. This re-points better-sqlite3 to the Electron ABI after `npm test` flipped it to Node ABI.

- [ ] **Step 7.3: Hand off**

Post the commits + the test results. The feature is ready for Greg to drive in `npm start`. He may iterate on:
- Final swatch palette
- Icon list curation in `IconPicker.tsx` for account-style icons
- Whether the type-icon at the start of each tab can be dropped now that the account chip carries identity (deferred — out of scope here)

---

## Self-review

- **Spec coverage**:
  - Schema migration → Task 1 ✓
  - Service-layer icon → Task 2 ✓
  - IPC + API plumbing → Task 3 ✓
  - AccountBadge compact variant → Task 4 ✓
  - AccountSettings icon picker + swatch grid → Task 5 ✓
  - TabManager reskin → Task 6 ✓
  - Final verification → Task 7 ✓
- **Placeholder scan**: no TBDs, no "implement later", every code-emitting step has actual code.
- **Type consistency**: `Account.icon: string \| null` is used identically in service, IPC, api.ts, AccountBadge, and AccountSettings. `IconPicker` props match how `IconPicker.tsx` already declares them.
- **Known minor judgement calls baked in**:
  - Default icon string is `"user"` (kebab-case key in `ICON_MAP`).
  - Default color in create form is `#3b82f6` (preserves existing behavior).
  - Swatch palette has 9 colors plus a fallback custom-hex input for user-chosen colors.
  - Active-state CSS uses `shadow-[inset_0_0_0_1px_hsl(var(--border))]` so the 1px border picks up the theme color rather than a hardcoded shade.

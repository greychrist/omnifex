# Verify - Full repo verification gate for OmniFex.

Run the full repo verification gate from the repo root. Stop on the first failure.

## Commands

Run all of the following from the repo root (`/Users/gregorychristie/Repos/personal/omnifex`):

```bash
npm run check
npm run build
npm run test:coverage
```

## Rules

- Report the exact commands that ran.
- Report pass/fail for each command.
- Stop on the first failing gate.
- For `npm run test:coverage`, also report the line coverage percentage for any modules touched by the current change. Target is 80% lines and it is repo-wide, not backend-only; flag any touched module below that.
- Run `npm run coverage:areas` after the coverage gate. It reads the report
  just produced and breaks it down by area (main process / React UI / renderer
  logic), ranking files by uncovered LINES rather than percentage. Report the
  per-area lines, not just the single blended number — the blend hides which
  population is actually short.
- If the change is narrowly scoped, it is fine to run smaller checks (`npm test`, `npm run check`) during implementation, but use this gate before claiming full verification.
- If a command cannot run because the environment is missing tooling, report that explicitly. Node.js + npm are the only requirements — there is no Rust toolchain, no `just`, and no `nix-shell` needed for the Electron stack.

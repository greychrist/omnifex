# Permission Prompt Redesign — Planning Notes

## Context

Greg is redesigning the permission-prompt UI. Current behavior was tested
this session:

- Writing to `/tmp/greychrist-permission-test.txt` prompted, then "always
  allow" persisted an entry.
- Writing inside the project dir auto-allowed (no prompt), because
  `.claude/settings.json` has `"defaultMode": "acceptEdits"`.
- Editing commands reportedly doesn't honor permissions well (to be
  investigated separately).

## Observed bug

"Always allow" for the `/tmp` write saved as:

```
Write(//tmp/greychrist-permission-test.txt)
Edit(//tmp/greychrist-permission-test.txt)
```

Note the **double leading slash**. Probably a normalization step
prepending `/` to an already-absolute path. Related to recent work in
967c2da and 15b04f7 on permission-rule path formatting. Worth fixing
independently of the UI redesign.

## Storage tiers

Four distinct locations where a rule can live:

| Scope       | File                                      | Shared with team? |
| ----------- | ----------------------------------------- | ----------------- |
| Session     | in-memory only                            | no                |
| Me Here     | `<project>/.claude/settings.local.json`   | no (gitignored)   |
| Me Global   | `~/.claude-personal/settings.json` (or `~/.claude/settings.json`) | no |
| Team        | `<project>/.claude/settings.json`         | yes (checked in)  |

"Save for me" is ambiguous between Me Here and Me Global — needs to be
split into two distinct options.

## Two orthogonal axes

A permission prompt has to answer two independent questions:

1. **Scope** — where does the rule persist? (Session / Me Here / Me
   Global / Team)
2. **Specificity** — how broad is the rule? (exact path / directory
   glob / tool-wide)

A combined button matrix is 4 × 3 = 12 combinations, which is too many.
Keep the axes visually separate.

## Proposed UI

- **Rule field** (top): shows the proposed rule, pre-filled with the
  exact match (e.g. `Write(/tmp/foo.txt)`). Editable. Quick-chip
  suggestions alongside to broaden: `Write(/tmp/**)`, `Write` tool-wide,
  custom directory.
- **Scope radios** (below): Session / **Me Here** / Me Global / Team.
  Default is **Me Here** — the common case is "persist for this repo".
- **Primary action**: `Allow` — saves the current rule at the selected
  scope.
- **Secondary action**: `Deny` — demoted styling. Rarely used outside
  emergencies; functions as a cancel-and-block.

Visually: rule is the subject, scope is the location, one confirm button.
User always sees exactly what rule is being persisted and where.

## Open questions

- Command-editing permissions reportedly don't work — needs a separate
  investigation. Test plan: create a slash command, try to edit it,
  observe which (if any) permission rule is checked.
- How should the UI behave when `defaultMode: "acceptEdits"` is set?
  Currently it silently bypasses prompts for in-project writes — should
  that be surfaced somewhere so users know why they aren't being asked?
- Keyboard-first interaction model: what are the default key bindings
  for scope radios and Allow/Deny?
- Should Me Global writes to `~/.claude-personal/` vs `~/.claude/`
  follow the resolved account's config dir, or always user-global?

## Out of scope for now

- Implementation — this is planning only.
- Fixing the `//tmp/...` double-slash bug — separate commit.
- Command-edit permission investigation — separate task.

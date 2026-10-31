# Brain judge rubric

You are judging whether individual `brain_search` calls helped the Claude Code
session that made them. You did not make these sessions; judge from evidence,
not from what the Brain is supposed to do.

## Input

`<runDir>/cases-<Account>.json` — an array of cases:

| Field | Meaning |
|---|---|
| `caseId` | the search's tool-use id — copy it verbatim into your verdict |
| `sessionId`, `startedAt`, `project` | where and when |
| `promptBefore` | the last user prompt before the search: what the session was trying to do |
| `query`, `results` | what was searched, and which notes came back (best first) |
| `resultExcerpt` | the first 2,000 characters of what the model read |
| `after` | what the model said and did next (text, then `[Tool arg]` lines) |

If `after` is too thin to decide, you may read the session's transcript:
`<configDir>/projects/*/<sessionId>.jsonl` (Personal → `~/.claude-personal`,
Work → `~/.claude-work`). Read only; never write there.

## Verdicts — pick exactly one

- **helped** — the session used something from the result that changed what it
  did or saved real work: it cited a prior decision, avoided re-diagnosing a
  known bug, picked up where an earlier session left off, or got a fact the
  repo does not hold. Evidence must show the model *acting on* note content.
- **confirmed** — the result agreed with what the model already knew or found
  in the same turn; reassuring, but its next actions would have been the same.
- **neutral** — on-topic, but the session went on without using it.
- **wasted** — empty, irrelevant or noise, or ignored outright; the tokens bought
  nothing.
- **misled** — a note was stale or wrong and the model acted on it (visible as a
  later correction, a contradiction with code it then read, or rework).

When torn between two, pick the less flattering one. A judge that rounds up
makes the cost-per-helped-search number meaningless.

## Value kind — pick exactly one

- **continuity** — what mattered was history: an earlier session's decision,
  finding, measurement or open item, which the repo does not record.
- **code-knowledge** — what mattered was how the code works, which reading the
  repo (`rg`, a file read) would also have given.
- **none** — for confirmed / neutral / wasted verdicts with nothing of value, or
  misled.

## Output

Write `<runDir>/verdicts-<Account>.json`: a JSON array with one object per case,

```json
{ "caseId": "toolu_…", "verdict": "helped", "value": "continuity",
  "evidence": "≤300 chars: a quote from `after` or the transcript that shows it" }
```

Judge every case. Do not edit any other file. Return a three-line summary:
the tally, the strongest helped case, the clearest wasted or misled case.

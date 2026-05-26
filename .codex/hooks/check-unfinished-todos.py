#!/usr/bin/env python3
"""
Stop hook: refuse to stop while the latest TodoWrite has unfinished items.

Pattern observed across many of Greg's sessions: the model marks the final
todo (typically "Report" / "Summarize") `in_progress` while composing the
closing message, then the conversation ends and the status is never flipped
to `completed`. OmniFex's UI (correctly) reads the latest TodoWrite as the
source of truth and surfaces a phantom in-flight item forever.

This hook reads the session transcript, finds the most recent TodoWrite,
and — if any todo is `pending` or `in_progress` — emits a `decision:block`
JSON response. Claude Code feeds the `reason` back to the model as a
system reminder so it can either mark the items completed or explain why
they're still open. The recursion guard (`stop_hook_active`) prevents an
infinite loop if the model can't address the warning.

Hook contract: reads JSON on stdin, writes JSON on stdout. See
https://code.claude.com/docs/en/hooks for the full schema.

Stays dumb on purpose: parses the JSONL, decides, prints. No filesystem
mutation, no calling out to other tools, no inventing todo state.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        # Malformed input — don't block, don't crash. Better to let the
        # session stop than wedge it because of a hook parsing error.
        return 0

    # Recursion guard: if this hook already fired and the model couldn't
    # resolve it, allow the stop on the second pass. Without this we'd
    # loop forever on genuinely-stuck todos (e.g. the model deliberately
    # left an item open because it can't be done in this session).
    if payload.get("stop_hook_active") is True:
        return 0

    transcript_path = payload.get("transcript_path")
    if not transcript_path:
        return 0

    p = Path(transcript_path)
    if not p.exists():
        return 0

    # Reverse-scan the JSONL for the latest TodoWrite tool_use, mirroring
    # the renderer's getLatestTodos() (src/lib/latestTodos.ts). Last one
    # wins.
    latest_todos: list[dict] | None = None
    try:
        with p.open("r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return 0

    for raw in reversed(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            continue

        if entry.get("type") != "assistant":
            continue
        message = entry.get("message") or {}
        content = message.get("content")
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if not isinstance(name, str) or name.lower() != "todowrite":
                continue
            todos = (block.get("input") or {}).get("todos")
            if isinstance(todos, list):
                latest_todos = todos
                break
        if latest_todos is not None:
            break

    if not latest_todos:
        return 0

    open_items = [
        t for t in latest_todos
        if isinstance(t, dict) and t.get("status") in ("pending", "in_progress")
    ]
    if not open_items:
        return 0

    # Build a short list for the directive — agent doesn't need the
    # whole payload, just the open items.
    summary = "\n".join(
        f"  - [{t.get('status', '?')}] {t.get('content', '?')}"
        for t in open_items
    )

    reason = (
        f"You have {len(open_items)} unfinished todo item"
        f"{'s' if len(open_items) != 1 else ''} in your latest TodoWrite call:\n"
        f"{summary}\n\n"
        "Either flip them to `completed` (or `cancelled` with a reason) via "
        "TodoWrite, or briefly explain why they're still open. OmniFex's "
        "session UI uses the latest TodoWrite as ground truth, so leaving "
        "items in-flight at session end shows a phantom open item forever."
    )

    response = {
        "decision": "block",
        "reason": reason,
    }
    json.dump(response, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())

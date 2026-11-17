#!/usr/bin/env bash
# Report which model the skill's turn actually ran on, from the CLI's own
# transcript — not from the model's self-report, which repeats the
# "You are powered by…" note even when the request went out on another model.
#
#   wanted    = command_permissions.model  (what the skill's `model:` resolved to)
#   requested = assistant.requestedModel   (what the CLI sent to the API)
#   served    = assistant.message.model    (what the API says answered)
#
# Reads the newest main-chain assistant record written after the skill loaded:
# the one whose tool_use is running this script.
set -euo pipefail

sid="${CLAUDE_CODE_SESSION_ID:-}"
cfg="${CLAUDE_CONFIG_DIR:-}"
[[ -n "$sid" ]] || { echo "which-model: CLAUDE_CODE_SESSION_ID is not set" >&2; exit 1; }
# Never fall back to ~/.claude: every session here runs with CLAUDE_CONFIG_DIR.
[[ -n "$cfg" ]] || { echo "which-model: CLAUDE_CONFIG_DIR is not set" >&2; exit 1; }

# Search rather than build the path: EnterWorktree relocates transcripts.
file="$(find "$cfg/projects" -maxdepth 2 -name "$sid.jsonl" -print -quit 2>/dev/null || true)"
[[ -n "$file" ]] || { echo "which-model: no transcript for session $sid under $cfg/projects" >&2; exit 1; }

# The assistant record that issued this Bash call may land a beat after the
# tool starts, so poll briefly for one that follows the skill's attachment.
query='
  [ .[] | select(.isSidechain|not) ] as $r
  | ([ $r | to_entries[] | select(.value.attachment.type=="command_permissions") ] | last) as $cp
  | if $cp == null then {error:"no skill load (command_permissions) in this session"}
    else
      ([ $r[$cp.key+1:][] | select(.type=="assistant") ] | last) as $a
      | if $a == null then {pending:true}
        else {
          wanted:    ($cp.value.attachment.model // "none (skill sets no model:)"),
          requested: ($a.requestedModel // "unknown"),
          served:    ($a.message.model // "unknown"),
          at:        $a.timestamp
        } end
    end'

for _ in $(seq 1 20); do
  out="$(jq -cs "$query" "$file")"
  [[ "$(jq -r '.pending // false' <<<"$out")" == "true" ]] || break
  sleep 0.25
done

if [[ "$(jq -r 'has("error")' <<<"$out")" == "true" ]]; then
  echo "which-model: $(jq -r .error <<<"$out")" >&2; exit 1
fi
if [[ "$(jq -r '.pending // false' <<<"$out")" == "true" ]]; then
  echo "which-model: this turn's assistant record never reached the transcript" >&2; exit 1
fi

wanted="$(jq -r .wanted <<<"$out")"
requested="$(jq -r .requested <<<"$out")"
served="$(jq -r .served <<<"$out")"

if [[ "$wanted" == none* ]]; then verdict="NO OVERRIDE — skill sets no model:"
elif [[ "$served" == "$wanted"* ]]; then verdict="HONORED — the skill ran on $served"
else verdict="IGNORED — skill asked for $wanted, API served $served"
fi

cat <<EOF
Skill model check  ($(jq -r .at <<<"$out"))
  wanted     $wanted
  requested  $requested
  served     $served
  verdict    $verdict
  transcript $file
EOF

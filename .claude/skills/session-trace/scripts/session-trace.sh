#!/bin/bash
# Gather everything OmniFex knows about one session, from disk, read-only.
#   bash session-trace.sh <session-uuid-or-prefix>
# Sources: ~/.omnifex{,-dev}/sessions/<id>.meta.json + .events.jsonl (daemon),
# <configDir>/projects/<project>/<id>.jsonl (the CLI transcript), app_logs in
# greychrist.db, and /healthz on the daemon ports.
set -uo pipefail
Q=${1:-}
[ -n "$Q" ] || { echo "usage: session-trace.sh <session-uuid-or-prefix>" >&2; exit 2; }
DB="$HOME/Library/Application Support/OmniFex/greychrist.db"

metas=$(ls -1 ~/.omnifex/sessions/"$Q"*.meta.json ~/.omnifex-dev/sessions/"$Q"*.meta.json 2>/dev/null || true)
transcripts=$(find ~/.claude-personal/projects ~/.claude-work/projects -maxdepth 2 -name "$Q*.jsonl" 2>/dev/null || true)
if [ -z "$metas" ] && [ -z "$transcripts" ]; then echo "no daemon session or CLI transcript matches '$Q'"; exit 1; fi

section() { printf '\n== %s\n' "$*"; }

for meta in $metas; do
  id=$(basename "$meta" .meta.json)
  section "daemon session $id  ($(dirname "$meta"))"
  python3 - "$meta" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for k in ('projectPath','configDir','agent','createdAt','updatedAt'): print(f"  {k}: {m.get(k)}")
o=m.get('options',{}); print(f"  options: model={o.get('model')} permissionMode={o.get('permissionMode')} effort={o.get('effort')} resume={o.get('resume', o.get('resumeSessionId'))}")
PY
  ev="${meta%.meta.json}.events.jsonl"
  if [ -f "$ev" ]; then
    python3 - "$ev" <<'PY'
import json,sys,os,datetime
p=sys.argv[1]; n=0; states=[]; last=None; kinds={}
with open(p) as f:
    for line in f:
        n+=1
        try: r=json.loads(line)
        except Exception: continue
        t=r.get('type')
        if t=='session.state': states.append(r)
        elif t=='event':
            k=r.get('kind'); kinds[k]=kinds.get(k,0)+1
            pl=r.get('payload') or {}; raw=pl.get('raw') or {}
            if isinstance(raw,dict) and raw.get('type') in ('result','system','user','assistant'): last=raw.get('type')+('/'+raw.get('subtype','') if raw.get('subtype') else '')
mt=datetime.datetime.fromtimestamp(os.path.getmtime(p)).isoformat(timespec='seconds')
print(f"  events.jsonl: {n} records, {os.path.getsize(p)//1024} KB, last write {mt}")
print(f"  event kinds: {kinds}")
print(f"  last CLI record seen through daemon: {last}")
print("  last session.state records:")
for s in states[-4:]:
    print(f"    seq={s.get('seq')} sessionStatus={s.get('sessionStatus')} turn={s.get('turn')}")
PY
  fi
done

for t in $transcripts; do
  section "CLI transcript $t"
  python3 - "$t" <<'PY'
import json,sys,os,datetime
p=sys.argv[1]; rows=[]
with open(p) as f:
    for line in f:
        try: rows.append(json.loads(line))
        except Exception: pass
mt=datetime.datetime.fromtimestamp(os.path.getmtime(p)).isoformat(timespec='seconds')
print(f"  {len(rows)} records, {os.path.getsize(p)//1024} KB, last write {mt}")
ver=next((r.get('version') for r in reversed(rows) if r.get('version')),None); print(f"  cli version: {ver}")
print("  last 8 records:")
for r in rows[-8:]:
    m=r.get('message') or {}; c=m.get('content'); desc=''
    if isinstance(c,list):
        desc=','.join(b.get('type','?')+('('+b.get('name','')+')' if b.get('type')=='tool_use' else '') for b in c if isinstance(b,dict))
    elif isinstance(c,str): desc='text:'+c[:60].replace('\n',' ')
    print(f"    {r.get('timestamp','')[11:19]} {r.get('type'):<10} {r.get('subtype') or ''} {m.get('stop_reason') or ''} {desc}")
# open tool_use without a tool_result = a turn the transcript cannot close by itself
uses={};
for r in rows:
    c=(r.get('message') or {}).get('content')
    if not isinstance(c,list): continue
    for b in c:
        if not isinstance(b,dict): continue
        if b.get('type')=='tool_use': uses[b.get('id')]=b.get('name')
        if b.get('type')=='tool_result': uses.pop(b.get('tool_use_id'),None)
print(f"  tool_use without tool_result: {len(uses)} {list(uses.values())[:5]}")
PY
done

if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
  section "app_logs mentioning $Q (last 10)"
  sqlite3 -separator ' | ' "$DB" "select substr(timestamp,1,19), level, source, substr(message,1,140) from app_logs where message like '%$Q%' or metadata like '%$Q%' order by id desc limit 10"
  section "app_logs error/warn, last 10 overall"
  sqlite3 -separator ' | ' "$DB" "select substr(timestamp,1,19), level, source, substr(message,1,140) from app_logs where level in ('error','warn') order by id desc limit 10"
fi

section "daemon health (47700 installed, 47701 dev)"
for port in 47700 47701; do
  # The daemon binds the host from server.json (often the Tailscale address), not loopback.
  addr=$(lsof -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1, $9}' | head -1)
  if [ -z "$addr" ]; then echo "  :$port nothing listening"; continue; fi
  hostport=${addr#* }
  h=$(curl -s -m 2 "http://$hostport/healthz" 2>/dev/null) && echo "  $addr → $h" || echo "  $addr listening but /healthz not answering"
done

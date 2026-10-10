#!/usr/bin/env python3
"""Role split + quality signals from omp session history.
Usage: model-routing-roles.py [days] [sessions_dir] [stats_db]"""
import collections as C, datetime, glob, json, os, re, sqlite3, sys, time
days = int(sys.argv[1]) if len(sys.argv) > 1 else 21
sd = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/.omp/agent/sessions")
db = sqlite3.connect(sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.omp/stats.db"))
cut = time.time() - days * 86400
role, comp, spans, idle = {}, [], [], 0.0
edit_err = loops = 0
for f in glob.glob(os.path.join(sd, "*", "*.jsonl")):
    if "/-tmp" in f or os.path.getmtime(f) < cut:
        continue
    T, prev = [], {}
    for line in open(f, errors="ignore"):
        try:
            j = json.loads(line)
        except ValueError:
            continue
        t = j.get("timestamp")
        if isinstance(t, str):
            try: T.append(datetime.datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp())
            except ValueError: pass
        if j.get("type") == "compaction":
            comp.append((j.get("tokensBefore") or 0, j.get("tokensAfter") or 0))
        m = j.get("message") or {}
        if m.get("role") == "toolResult":
            n, e = m.get("toolName"), bool(m.get("isError"))
            edit_err += n == "edit" and e
            loops += e and prev.get(n, False)
            prev[n] = e
            if n == "task":
                d = m.get("details") or {}
                for p in (d.get("results") or []) + (d.get("progress") or []):
                    if p.get("id"): role[p["id"]] = p.get("agent") or "?"
    if len(T) > 1:
        T.sort(); spans.append(T[-1] - T[0]); idle += sum(b - a for a, b in zip(T, T[1:]) if b - a > 300)
print(f"main sessions {len(spans)} wall_h {sum(spans)/3600:.1f} idle>5m_h {idle/3600:.1f}")
n = max(1, len(comp))
print(f"compactions {len(comp)} avg {sum(c[0] for c in comp)/n/1e3:.0f}K -> {sum(c[1] for c in comp)/n/1e3:.0f}K")
print(f"edit errors {edit_err}; consecutive same-tool error pairs {loops}")
agg = C.defaultdict(lambda: [0, 0.0, 0.0, 0])
for sf, mo, k, du, co, er in db.execute("select session_file,model,count(*),sum(duration),sum(cost_total),sum(stop_reason='error') "
        "from messages where agent_type='subagent' and timestamp>? and folder not like '%tmp%' group by 1,2", (cut * 1000,)):
    a = agg[(role.get(os.path.basename(sf)[:-6], "unmapped"), mo)]
    a[0] += k; a[1] += du or 0; a[2] += co; a[3] += er
for (r, mo), a in sorted(agg.items(), key=lambda x: -x[1][2]):
    print(f"ROLE {r:20} {mo:20} calls {a[0]:6} h {a[1]/3.6e6:5.1f} ${a[2]:8.2f} err {a[3]}")
for msg, k in db.execute("select substr(coalesce(error_message,''),1,80),count(*) from messages where timestamp>? "
        "and stop_reason in ('error','aborted') group by 1 order by 2 desc limit 8", (cut * 1000,)):
    print(f"ERR {k:4} {msg}")
rx = re.compile(r"不对|重来|回滚|revert|错了|wrong|undo", re.I)
cor = C.Counter(mo for p, mo in db.execute("select prose,model from user_messages where timestamp>? and folder not like '%tmp%'", (cut * 1000,)) if rx.search(p or ""))
print("correction-like user messages by model", dict(cor))

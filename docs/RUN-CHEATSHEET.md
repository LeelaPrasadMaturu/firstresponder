# ⚡ RUN-CHEATSHEET — every command, in order

> The operational companion to DEMO.md. Copy-paste these on the day.
> (Context: sandbox test aborted mid-verify — run §4 to confirm the phone-gate
> fix on your Mac, where the full stack lives.)

---

## 0 · One-time state check (after the interrupted run)

The last automated execute + phone-approval test was cut off mid-flight.
Check whether it completed, then clean up:

```bash
tail -25 ~/Desktop/hackathon-trufoundry/firstresponder/.firerun 2>/dev/null
tail -30 /tmp/execute-final.log     # the execute run (macOS /tmp)
cat    /tmp/phone.log               # the phone-simulator result
# if "approve → 200" appears in phone.log AND the execute log shows
# step-5 → DONE + addendum → THE PHONE PATH IS PROVEN. Skip to §5.
```

---

## 1 · Terminal layout (3 terminals + phone)

```bash
# TERMINAL 1 — The Stage (fake prod, twin, cluster-B, registry, pager)
cd ~/Desktop/hackathon-trufoundry/firstresponder/the-stage
docker compose up -d
# choreography: put prod on the leaky release
curl -s -XPOST localhost:8080/admin/deploy -H 'content-type: application/json' -d '{"version":"v2.1.0"}'
curl -s localhost:8080/admin/state      # → version: v2.1.0, leakOn: true

# TERMINAL 2 — TrueForge (with the two operational flags)
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' \
NODE_OPTIONS="--unhandled-rejections=warn" \
npx @truefoundry/trueforge@latest
# → http://localhost:8790  (UI: agents, sessions, schedules, settings)

# TERMINAL 3 — the engine
cd ~/Desktop/hackathon-trufoundry/firstresponder/firerun
npm run tf:mcp        # Stage tools as MCP (safe: exits with a hint if port busy)
npm run tf:setup      # idempotent: provider + MCP + 3 agents + schedule
npm run tf:smoke      # 60s sanity: session → turn → tool via TF
```

## 1.5 · The NOC dashboard (the big screen)

```bash
cd ~/Desktop/hackathon-trufoundry/firstresponder/firerun
npm run dashboard          # → http://localhost:8095  (zero deps, plain node)
open http://localhost:8095/            # Alert Command Center (home — demo actions, Leak Lab, charts, console)
# 🧪 Leak Lab (home page): simulate N requests every S sec × B bursts — each request is a real
#   Scenario triggers arm every runbook: leak (deploy v2.1.0) · latency (traffic 4200) ·
#   orphan pool (pool event-pool 6) · release-rollout (twin → Daytona soak → YOUR gate → prod)
open http://localhost:8095/noc         # legacy NOC big-screen memory view (optional)
# the raw file also works standalone: it auto-connects to the :8095 API

# DAYTONA (cloud sandbox) — ANALYST & SCRIBE run their doubt-verification code here:
#   proof: TF session events show sandbox.created with sandbox_id "v1:daytona:..."
#   see: curl -s localhost:8790/api/v1/settings/sandbox-providers  (status: ready)
```

- Scrapes REAL Prometheus `/metrics` from prod + twin + cluster-B every 2s (the scrape
  itself drives the leak's memory growth — exactly how production leaks surface).
- Panels: prod-vs-twin memory chart w/ 512MB OOM line · traffic/SLO · infra & cost ·
  all 10 runbook Execution Graphs (step types, gates, last-run status) · live HMAC
  audit stream · flywheel git receipts · open-gate banner · demo choreography buttons.
- Screen layout: NOC on the big display, firerun console + gate UI on the laptop.

### Where to SEE each layer (judges will ask)

```bash
curl -s localhost:18081/admin/state        # the TWIN — rehearsals ran here, prod untouched
docker ps --format '{{.Names}}' | grep -E 'twin|prod'   # twin-app/twin-db = same image+seed as prod
curl -s localhost:8790/api/v1/settings/sandbox-providers | python3 -m json.tool   # Daytona: ready
ls -t firerun/.firerun/runs | head         # tf-rehearse-* (twin proof) · tf-execute-* (prod runs)
                                           # + rehearsal-<fp>.json = the invariant marker that unlocks execute
jq . firerun/.firerun/runs/tf-rehearse-*/state.json | less   # per-step results against the twin
```

- **Rehearsal** ran on the TWIN container (same image + same DB seed as prod) — its per-step
  receipts are in `.firerun/runs/tf-rehearse-*/state.json`; the TF UI session transcripts open
  with "REHEARSAL MODE: you are running against the STAGING TWIN".
- **Daytona** is TrueForge's SANDBOX provider (not the twin): the agent's exploratory `exec`
  commands run isolated there — watch them stream live in the NOC audit panel (`tool: exec`).
- **Prod** is only touched after a green rehearsal + your phone approval — every decision lands
  in `AUDIT.jsonl` and on the NOC banner.
- **Git**: commits land in the LOCAL `the-stage` repo. No GitHub, no remote, nothing pushed.

## 2 · Preflight (60 seconds, before every demo)

```bash
npm run demo:verify                       # Stage 9/9 green
curl -s localhost:8790/api/v1/capabilities -o /dev/null -w "TF %{http_code}\n"          # 200
curl -s localhost:7789/healthz             # {"ok":true,"tools":6}
curl -s localhost:8790/api/v1/agents | python3 -m json.tool | grep name   # 6 firerun-* agents (scout·analyst·surgeon·executor·verifier·scribe)
curl -s localhost:8790/api/v1/settings/sandbox-providers | python3 -c "import json,sys; print('Daytona:', json.load(sys.stdin)['data']['status'])"   # ready
curl -s localhost:8080/admin/state         # v2.1.0 leakOn true (choreography)
```

## 3 · Phone setup (the approval moment)

```bash
# laptop hotspot ON; phone joined to it; then:
npm run cli -- execute ../the-stage/runbooks/incident-memory-leak.md
# the log prints:  Phone      http://<LAN-IP>:7788/gate   (same network)
# → open THAT url on the phone → tap Approve at the step-5 gate
```
- If the LAN URL 404s from the phone → client isolation; hotspot fixes it.
- Fallback: `FIRERUN_GATE=cli npm run cli -- execute ...` (approve in terminal).
- Venue rule: test at 09:00, never first-at 19:00.

## 4 · THE rehearsal→execute loop (compliance proof)

```bash
# rehearse first — the invariant REQUIRES a green rehearsal for this graph
npm run cli -- rehearse ../the-stage/runbooks/incident-memory-leak.md
# expect: steps 1–4 ✅, forge finds undos, (auto-approves in rehearsal)

# then live:
npm run cli -- execute ../the-stage/runbooks/incident-memory-leak.md
# → phone gate at step-5 → addendum appended → git commit in the-stage
git -C ../the-stage log --oneline -3     # the flywheel receipt
```

## 5 · The full demo run-order (40 min stage set)

```bash
# ACT 1 — incident (above). Then:

# ACT 2 — the infra pair (autonomous + cost story)
curl -s -XPOST localhost:8080/admin/traffic -H 'content-type: application/json' -d '{"rps":4200}'   # spike already set
npm run cli -- rehearse ../the-stage/runbooks/infra-scale-up.md
npm run cli -- execute  ../the-stage/runbooks/infra-scale-up.md      # ZERO gates by design
curl -s -XPOST localhost:8080/admin/traffic -H 'content-type: application/json' -d '{"rps":1000}'   # event over
npm run cli -- rehearse ../the-stage/runbooks/infra-scale-down.md
npm run cli -- execute  ../the-stage/runbooks/infra-scale-down.md    # addendum records $ reclaimed

# ACT 3 — the knife (gates + refusal)
npm run cli -- rehearse ../the-stage/runbooks/infra-delete.md
npm run cli -- execute  ../the-stage/runbooks/infra-delete.md
# gate 1: approve (tested undo) · gate 2: NO SAFE UNDO → Reject → the refusal
```

## 6 · The unattended story (TF-native)

```bash
# nightly sweep is a real TF schedule (01:00 IST, firerun-verifier):
curl -s localhost:8790/api/v1/schedules | python3 -m json.tool
# trigger one NOW for the demo:
SCH=$(curl -s localhost:8790/api/v1/schedules | python3 -c "import json,sys; print(json.load(sys.stdin)['data'][0]['id'])")
curl -s -XPOST localhost:8790/api/v1/schedules/runs -H 'content-type: application/json' -d "{\"schedule_id\":\"$SCH\"}"
# watch it in the TF UI → Schedules → run history (and Sessions)
```

## 7 · Troubleshooting

| Symptom | Fix |
|---|---|
| dashboard blank | `npm run dashboard`, check `/tmp/dash.log`; panels go dark if Stage is down — restart Stage |
| `EADDRINUSE :8790` | an old TF is running: `lsof -ti :8790 \| xargs kill`, restart with the flags from §1-T2 |
| `tf:mcp` exits, port busy | stale MCP instance: `lsof -ti :7789 \| xargs kill` → `npm run tf:mcp` |
| 502 listing MCP tools | the MCP server died — restart T3 `npm run tf:mcp`, check `/tmp/mcp.log` |
| Model 401 via Portkey | create a Virtual Key in the Portkey dashboard → `PORTKEY_VIRTUAL_KEY` in `.env` → `npm run tf:setup` |
| Forge says UNABLE wrongly | it now receives the runbook commands; if still unsure it fails SAFE (blocked, escalated) — that's on-message |
| step-5 slow | gated approval cycles × model latency; in rehearsal it's auto-approved; for the live demo the pause IS the moment |
| TF crashes on abandoned streams | start TF with `NODE_OPTIONS="--unhandled-rejections=warn"` (§1-T2 already includes it) |
| Phone can't reach gate | venue wifi isolation → hotspot both devices |

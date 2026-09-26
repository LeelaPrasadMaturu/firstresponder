# Orphaned event-pool cleanup — forgotten min-instances (cost hygiene)

Runbook owner: @platform-team
Severity: SEV-3 (money leak, not user-facing)
Last verified: 2026-09-26
Runbook version: 1.0.0
Last updated: 2026-09-26 — initial orphan-capacity flow
  (scout inventories cost → analyst confirms idle → EXECUTOR decommissions at a
   human gate with a tested undo → verifier asserts the reclaim)
Version history: v1.0.0 2026-09-26 initial release

Trigger: weekly cost review flagged `event-pool` burning $/day with zero
traffic. Classic accident: a launch scaled the event pool (min-instances)
and everyone forgot to delete it. The pool costs $0.30/hr per node — every
forgotten node is $7.20/day of pure waste. This runbook names the waste in
dollars, proves the capacity is idle, and decommissions it at a human gate
with a tested undo (the pool can be recreated at the same size instantly).

## Step 1 — Inventory the pools and price the waste
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectContains=event-pool -->
Name the orphan precisely: node count, $/hr, $/day, and what it was for.

```bash
STATE=$(curl -s $APP_URL/admin/state)
echo "$STATE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
pool=[p for p in d['pools'] if p['name']=='event-pool'][0]
print(f\"event-pool: {pool['size']} nodes @ \${pool['rate_usd_hr']}/hr = \${round(pool['size']*pool['rate_usd_hr']*24,2)}/day of pure waste if idle\")"
```

## Step 2 — Prove the capacity is truly idle
<!-- firerun: type=READ -->
A pool may only be deleted if current traffic needs none of it. Branch on the
live capacity math — state the branch and the evidence:

```bash
RPS=$(curl -s $APP_URL/slo | python3 -c "import json,sys; print(json.load(sys.stdin)['traffic_rps'])")
BASE_CAP=$(curl -s $APP_URL/admin/state | python3 -c "import json,sys; d=json.load(sys.stdin); print([p for p in d['pools'] if p['name']=='core-pool'][0]['size'] * 500 + d['replicas'] * 100)")
if [ "$RPS" -lt "$BASE_CAP" ]; then
  echo "BRANCH=orphan-confirmed — traffic ${RPS}rps fits in base capacity ${BASE_CAP}rps: event-pool is idle, safe to decommission"
else
  echo "BRANCH=in-use — traffic ${RPS}rps exceeds base capacity ${BASE_CAP}rps: event-pool is load-bearing, do NOT delete"
fi
```

## Step 3 — Decommission the orphaned nodes (gated)
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="event-pool nodes terminated; ~$X/day spend reclaimed; capacity headroom reduced by nodes×500rps" -->
HUMAN GATE. Decommissioning terminates the nodes. The undo below was executed
against the staging twin during rehearsal (recreate at the same size), which
is why this step is allowed to run at all — no undo, no action:

```bash
curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":0}'
```

Undo: `curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":6}'`

## Step 4 — Verify the reclaim
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=slo_ok -->
<!-- firerun-probe: http /admin/state expectContains=core-pool -->
Independent verification: core capacity untouched, SLO still green, cost
model updated. Report the reclaimed $/day from the live state — the next
weekly cost review starts with this number already better.

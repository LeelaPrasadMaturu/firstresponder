# Post-event scale-down — order-service (cost reclamation)

Runbook owner: @sre-team
Severity: routine
Last verified: 2026-09-26

Trigger: the event window has ended. The mirror image of infra-scale-up —
and deliberately STRICTER, because over-descale into residual traffic is a
user-visible outage. The safe-to-descale precondition (Step 2) is a hard
VERIFY: if residual traffic is too high, the run halts and the clusters
stay warm. Saving $30 is never worth a dinner-peak blip.

CHOREOGRAPHY (set before rehearsing — the post-event state):
  curl -s -XPOST $PROD_APP_URL/admin/traffic -H 'content-type: application/json' -d '{"rps":1000}'
Baseline: replicas 40 + event-pool(4) → capacity 6,000 rps vs 1,000 rps
load → paying for 6x the traffic that exists.

## Step 1 — Baseline: replicas, traffic, and daily spend
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectStatus=200 -->
Record the "before" cost — the flywheel will compare against the "after"
so the addendum records the actual dollars reclaimed, not an estimate.

## Step 2 — Verify the safe-to-descale precondition
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=descale_safe -->
Residual traffic must be ≤ 30% of replica capacity. If the event is still
live (or traffic shifted later than forecast), this probe FAILS the run
here — the correct outcome is "stay scaled up," not "hope."

## Step 3 — Descale order-service replicas 40 → 15
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — reversible; precondition verified in step 2; undo = scale back to 40" -->

```bash
curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":15}'
```

Undo: `curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":40}'`

## Step 4 — Scale the event node pool 4 → 0
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — reversible; the actual cost reclamation (-$28.80/day); undo = provision 4 nodes" -->

```bash
curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":0}'
```

Undo: `curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":4}'`

## Step 5 — Verify SLO held after descale
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=slo_ok -->
p99 must be unchanged from baseline. A latency regression after descale
means we cut too deep — the undo exists and the runbook says to use it.

## Step 6 — Verify headroom is retained for normal traffic
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=headroom_ok -->
Descaled capacity must still carry ≤80% utilization at normal load.
Over-descaled "savings" that break the next small spike are not savings.

## Step 7 — Record the reclaimed cost
<!-- firerun: type=READ -->
<!-- firerun-probe: http /metrics expectContains=cost_usd_daily -->
Compare daily spend vs the Step 1 baseline. The flywheel appends the
actual delta to the runbook — the cost runbook that measures itself.

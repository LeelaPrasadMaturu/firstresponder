# Pre-event scale-up — order-service (IPL-final traffic pattern)

Runbook owner: @sre-team
Severity: high
Last verified: 2026-09-26

Trigger: capacity forecast alert, or manual, ~30 min before a predicted
traffic spike (think: IPL final, Friday dinner peak, New Year's Eve).
The whole point: scale-up is REVERSIBLE, so it runs autonomously — no human
should have to tap "approve" at 7 PM on a Sunday. Only the VERIFY steps can
halt the run.

CHOREOGRAPHY (set before rehearsing, simulates the pre-event spike):
  curl -s -XPOST $PROD_APP_URL/admin/traffic -H 'content-type: application/json' -d '{"rps":4200}'
Baseline: replicas 10 + core-pool(4) → capacity 1,000 rps vs 4,200 rps load
→ p99 ≈ 240ms → SLO breach. The runbook restores headroom.

## Step 1 — Baseline the current capacity position
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectStatus=200 -->
Record replicas, node count, current p99, traffic, and daily cost. This is
the "before" for the flywheel's cost/impact accounting.

## Step 2 — Confirm the traffic forecast justifies scale-up
<!-- firerun: type=READ -->
<!-- firerun-probe: http /slo expectContains=slo_breach -->
The breach IS the justification: p99 outside SLO at current capacity means
we scale now, not after the error budget burns. If this probe finds
`slo_ok` (spike didn't materialize), the run still completes — but the
addendum records that scale-up was precautionary.

## Step 3 — Raise the HPA ceiling
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — config only; undo = restore max 20" -->
Raise the autoscaler ceiling so it is not the bottleneck during rollout:

```bash
curl -s -XPOST $APP_URL/admin/hpa -H 'content-type: application/json' -d '{"max":60}'
```

Undo: `curl -s -XPOST $APP_URL/admin/hpa -H 'content-type: application/json' -d '{"max":20}'`

## Step 4 — Scale order-service replicas 10 → 40
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — reversible; brief rollout churn; undo = scale back to 10" -->

```bash
curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":40}'
```

Undo: `curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":10}'`

## Step 5 — Provision the event node pool 0 → 4 nodes
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="cost +$28.80/day while provisioned; fully reversible by scaling the pool to zero" -->
The replica capacity alone (4,000 rps) is below the 4,200 rps forecast —
the event pool adds burst headroom:

```bash
curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":4}'
```

Undo: `curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":0}'`

## Step 6 — Verify p99 is back inside SLO
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=slo_ok -->
Latency is the user-facing contract. Capacity without latency relief is not
scale-up, it is spend.

## Step 7 — Verify capacity headroom is restored
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=headroom_ok -->
Traffic must sit at ≤80% of capacity. Scaling to exactly the forecast is
how the next spike becomes an incident.

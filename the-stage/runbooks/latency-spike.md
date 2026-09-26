# P99 latency spike — capacity triage (signer-prod)

Runbook owner: @platform-team
Severity: SEV-2 when SLO breached, SEV-3 otherwise
Last verified: 2026-09-26
Runbook version: 1.0.0
Last updated: 2026-09-26 — initial capacity-triage flow
  (scout quantifies → analyst root-causes → surgeon adds reversible capacity →
   verifier asserts the SLO → analyst records the post-event plan)
Version history: v1.0.0 2026-09-26 initial release

Trigger: SLO burner `signer-prod p99 > 150ms`. Latency here is REAL capacity
math, not a random number: the service computes p99 from live traffic vs live
capacity (replicas × 100rps + event-pool nodes × 500rps). When traffic exceeds
capacity, p99 climbs — exactly like production. This runbook triages the spike,
adds capacity reversibly, and verifies the SLO from the rendered endpoint.

## Step 1 — Quantify the spike against the SLO
<!-- firerun: type=READ -->
<!-- firerun-probe: http /slo expectContains=slo_ -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
Read live p99, traffic and capacity. Branch on severity — state the branch:

```bash
SLO=$(curl -s $APP_URL/slo)
P99=$(echo "$SLO" | python3 -c "import json,sys; print(json.load(sys.stdin)['p99_ms'])")
if [ "${P99:-0}" -gt 150 ]; then
  echo "BRANCH=slo-breach — p99 ${P99}ms > 150ms SLO: full triage now"
else
  echo "BRANCH=within-slo — p99 ${P99}ms: log and continue watching"
fi
```

## Step 2 — Root-cause: traffic vs capacity
<!-- firerun: type=READ -->
Latency spikes have exactly two classes here: demand exceeds capacity, or a
dependency degraded. Compute headroom from the live numbers and branch:

```bash
RPS=$(curl -s $APP_URL/slo | python3 -c "import json,sys; print(json.load(sys.stdin)['traffic_rps'])")
CAP=$(curl -s $APP_URL/slo | python3 -c "import json,sys; print(json.load(sys.stdin)['capacity_rps'])")
if [ "$RPS" -gt "$CAP" ]; then
  echo "BRANCH=capacity-exhausted — ${RPS}rps demand vs ${CAP}rps capacity (overload ratio $(python3 -c "print(round($RPS/$CAP,2))")): add capacity"
else
  echo "BRANCH=dependency-latency — capacity is fine (${CAP}rps vs ${RPS}rps): investigate upstream instead"
fi
```

## Step 3 — Add capacity (reversible)
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="extra compute spend (~$3.4/hr) while scaled; fully reversible via admin/scale + admin/pools" -->
Scale the fixed pool to its HPA ceiling and open event-pool capacity to absorb
the surge. Both actions are reversible to the exact pre-spike state:

```bash
curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":20}'
curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":6}'
```

Undo (restores the pre-spike fleet exactly):
```bash
curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":10}'
curl -s -XPOST $APP_URL/admin/pools -H 'content-type: application/json' -d '{"name":"event-pool","size":0}'
```

## Step 4 — Verify the SLO recovered
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /slo expectContains=slo_ok -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
Independent verification from the rendered endpoint: p99 must be back under
150ms (`slo_ok`), health unchanged.

## Step 5 — Post-event plan and evidence record
<!-- firerun: type=READ -->
<!-- firerun-probe: http /slo expectContains=headroom_ -->
Record the final state and branch on the post-event plan — capacity is kept
ONLY while the event lasts, then the descale runbook takes over:

```bash
RPS=$(curl -s $APP_URL/slo | python3 -c "import json,sys; print(json.load(sys.stdin)['traffic_rps'])")
if [ "$RPS" -gt 3000 ]; then
  echo "BRANCH=event-active — keep scaled capacity until traffic drops below 3000rps, then run infra-scale-down"
else
  echo "BRANCH=event-over — traffic normal: run infra-scale-down now to reclaim spend"
fi
```

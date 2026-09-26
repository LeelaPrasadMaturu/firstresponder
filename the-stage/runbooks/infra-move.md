# Cluster migration — move order-service from cluster-A to cluster-B

Runbook owner: @sre-team
Severity: SEV-2-if-wrong
Last verified: 2026-09-26

Real-world shape: evacuate a bad AZ, upgrade a cluster's Kubernetes
version, or move a service to a new cluster. In the Stage: cluster-A is
`$PROD_APP_URL` (primary), cluster-B is `$CLUSTER_B_APP_URL` (standby).

TWO GATES, deliberately:
  · Gate 1 — traffic cutover (the moment users ride on the new cluster)
  · Gate 2 — decommission of the old cluster (the point of no return)
Everything before Gate 1 is reversible and runs autonomously.

## Step 1 — Snapshot cluster-A's state (the rollback source of truth)
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectStatus=200 -->
Record version, replicas, node pools, cost. If the migration aborts
anywhere, this snapshot defines "back to normal."

## Step 2 — Provision order-service on cluster-B
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — cluster-B serves no traffic yet; undo = scale cluster-B back to zero replicas" -->
Same release, same capacity, zero traffic:

```bash
curl -s -XPOST $CLUSTER_B_APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'
curl -s -XPOST $CLUSTER_B_APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":10}'
curl -s -XPOST $CLUSTER_B_APP_URL/admin/traffic -H 'content-type: application/json' -d '{"rps":0}'
```

Undo: `curl -s -XPOST $CLUSTER_B_APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":0}'`

## Step 3 — Verify cluster-B serves the full surface before any traffic moves
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/healthz" expectContains=mem_ok -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/pricing" expectContains=Pricing -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/status" expectContains=operational -->
The new cluster must prove it can serve users BEFORE users are sent to it.
A cold cluster that fails here halts the run — no cutover to a broken
target, ever.

## Step 4 — Warm cluster-B (caches, connections, JIT'd paths)
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — synthetic load on cluster-B only; undo = traffic back to 0" -->
Give cluster-B realistic load so the first real requests don't hit cold
caches:

```bash
curl -s -XPOST $CLUSTER_B_APP_URL/admin/traffic -H 'content-type: application/json' -d '{"rps":400}'
```

Undo: `curl -s -XPOST $CLUSTER_B_APP_URL/admin/traffic -H 'content-type: application/json' -d '{"rps":0}'`

## Step 5 — CUT TRAFFIC: promote cluster-B to primary (GATE 1)
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="100% of order traffic now rides on cluster-B; user-visible if cluster-B is unhealthy; undo = flip roles back (~60s, rehearsed)" -->
The simulated load-balancer weight flip. This is the single most dangerous
moment of any migration — hence the gate, with the Step 3 verification
attached as evidence:

```bash
curl -s -XPOST $CLUSTER_B_APP_URL/admin/role -H 'content-type: application/json' -d '{"role":"primary"}'
```

Undo: `curl -s -XPOST $CLUSTER_B_APP_URL/admin/role -H 'content-type: application/json' -d '{"role":"standby"}'`

## Step 6 — Verify the NEW cluster is actually serving users
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/admin/state" expectContains="primary" -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/" expectContains=ACME -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/slo" expectContains=slo_ok -->
"Promoted" is a claim; this step is the proof. Pages render, SLO holds,
role is primary. Only a green Step 6 earns Step 7.

## Step 7 — Decommission cluster-A (GATE 2 — the point of no return)
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="cluster-A stops serving permanently; capacity now depends entirely on cluster-B; undo = restore role primary (possible but means re-migrating) — treated as accepting the new topology" -->
The old cluster goes away. The undo exists but represents going back to
square one — the gate card says so explicitly:

```bash
curl -s -XPOST $PROD_APP_URL/admin/role -H 'content-type: application/json' -d '{"role":"decommissioned"}'
```

## Step 8 — Final verification of the new topology
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "curl -s $PROD_APP_URL/admin/state" expectContains=decommissioned -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/healthz" expectContains=mem_ok -->
<!-- firerun-probe: command "curl -s $CLUSTER_B_APP_URL/status" expectContains=operational -->
Cluster-A decommissioned, cluster-B healthy and serving every page. The
flywheel records the migration — including actual cost delta if pool sizes
changed — so the next cluster migration starts from what happened, not
what was planned.

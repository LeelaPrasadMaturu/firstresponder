# Infra monitoring sweep — health, memory, capacity, cost signals (READ-ONLY)

Runbook owner: @sre-team
Severity: routine
Last verified: 2026-09-26

Purpose: the nightly capacity & health sweep an engineer does by hand.
This runbook is 100% READ + VERIFY — zero gates by design, so it is safe
to run autonomously on a schedule. Any VERIFY failure halts the run and
escalates to the on-call channel. In a real deployment, the cost/cluster
probes point at Prometheus, CloudWatch Billing, and the cluster API — the
convention is identical, only the probe targets change.

## Step 1 — Snapshot service state and release
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectStatus=200 -->
Record the currently deployed release, leak flag, and memory footprint.
This is the "baseline" every later comparison is made against.

## Step 2 — Verify health marker and memory budget
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
Health must report mem_ok. In a real cluster this maps to: RSS < limit on
every pod, p99 latency < SLO, error rate < 0.1%. A breach here halts and
pages — it never attempts a fix (that is a different runbook's job).

## Step 3 — Verify the full page surface renders
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: content / expectContains=ACME -->
<!-- firerun-probe: content /pricing expectContains=Plans -->
<!-- firerun: content probes on every user-facing surface -->
<!-- firerun-probe: content /status expectContains=operational -->
Exit codes lie; pixels don't. Every user-facing page must render its full
content — this is the front-of-glass check, run every night, not just on
deploys.

## Step 4 — Audit data-layer capacity
<!-- firerun: type=READ -->
<!-- firerun-probe: db "SELECT count(*) FROM orders" expectRows=">0" -->
Row count trend is the growth signal behind every capacity plan. On Swiggy
infrastructure this is the same query pattern against the orders/cassandra
metrics store: growth rate vs. provisioned headroom.

## Step 5 — Verify no corrupted state is silently accumulating
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: db "SELECT count(*) FROM cache_shards WHERE corrupted" expectRows="=0" -->
Zero corrupted shards is the invariant. Anything above zero is a leading
indicator of the retry-storm memory-leak incident — catch it here, at
01:00 in a monitoring sweep, instead of at 03:00 as a SEV-2 page.

## Step 6 — Compile the sweep report (agent-authored)
<!-- firerun: type=READ -->
Scout compiles every observation from steps 1–5 into a single report:
release, memory trend, page-surface status, row-count trend, shard health.
The flywheel appends this as the runbook addendum, so each night's sweep
becomes a timestamped line of operational history. In production, the same
step would also gather: per-cluster node counts, pod counts, cost-usage
deltas vs. the weekly budget, and top-5 spend movers.

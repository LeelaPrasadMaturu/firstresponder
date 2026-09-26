# Decommission the legacy dispatch-notifications stack

Runbook owner: @platform-team
Severity: high
Last verified: 2026-09-26

The pattern every deletion runbook must follow: **the runbook's job is to
make deletion reversible BEFORE it deletes.** Archive first, prove the
archive restorable, and only then hold each delete at its gate.

DESIGN NOTE (an emergent rule of this runtime): a step marked
`no-undo=true` can never pass a green rehearsal — the rehearsal-prerequisite
invariant blocks the whole graph. So this runbook uses no `no-undo` steps:
every delete below has a tested undo, because we BUILT the undo first
(Step 3). Authors who declare no-undo accept that their runbook requires an
explicit human override in rehearsal AND execution, every single time.

TARGET (seeded in the Stage DB):
  · 5 Kafka-style topics — 4 with zero consumers for 30+ days
  · 1 topic STILL LIVE: payments-settlement-v1 — must survive untouched
  · 2 persistent volumes with snapshots DISABLED (the scary class)

## Step 1 — Inventory exactly what will be deleted
<!-- firerun: type=READ -->
<!-- firerun-probe: db "SELECT count(*) FROM legacy_topics" expectRows="=5" -->
<!-- firerun-probe: db "SELECT count(*) FROM legacy_pvs" expectRows="=2" -->
Nothing gets deleted that wasn't first named and counted. In a real
environment this step also lists DNS records, dashboards, and alerts
owned by the stack.

## Step 2 — Evidence: zero traffic for 30+ days
<!-- firerun: type=READ -->
<!-- firerun-probe: db "SELECT count(*) FROM legacy_topics WHERE consumers_active = 0 AND last_consumed_at < now() - interval '30 days'" expectRows="=4" -->
Four of five topics are stale. If this count ever differs from the
inventory, the stack changed since the runbook was written — halt, do not
delete on stale evidence.

## Step 3 — Archive before the knife (the step that MAKES deletion reversible)
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — creates a backup table; undo = DROP TABLE legacy_topics_backup" -->

```bash
docker exec prod-db psql -U stage -d stagedb -c "DROP TABLE IF EXISTS legacy_topics_backup; CREATE TABLE legacy_topics_backup AS SELECT * FROM legacy_topics;"
```

Undo: `docker exec prod-db psql -U stage -d stagedb -c "DROP TABLE IF EXISTS legacy_topics_backup;"`

## Step 4 — Verify the archive is restorable (an untested backup is not a backup)
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: db "SELECT count(*) FROM legacy_topics_backup" expectRows="=5" -->
The backup must contain the full inventory. If this probe fails, the
runtime will not let Step 5 run — the rehearsal-prerequisite and
undo-validation invariants catch it before prod is touched.

## Step 5 — DELETE the stale topics (gate 1 of 2)
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="4 of 5 topics permanently dropped (dispatch-notifications-v1, order-events-raw-v1, search-index-updates-v1, de-featured-ml-features-v1); payments-settlement-v1 untouched; undo restores all 4 from legacy_topics_backup" -->

```bash
docker exec prod-db psql -U stage -d stagedb -c "DELETE FROM legacy_topics WHERE consumers_active = 0 AND last_consumed_at < now() - interval '30 days';"
```

Undo: `docker exec prod-db psql -U stage -d stagedb -c "INSERT INTO legacy_topics (topic_name, consumers_active, last_consumed_at, partitions) SELECT topic_name, consumers_active, last_consumed_at, partitions FROM legacy_topics_backup WHERE consumers_active = 0 AND last_consumed_at < now() - interval '30 days';"`

## Step 6 — Verify the LIVE topic was untouched
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: db "SELECT count(*) FROM legacy_topics WHERE topic_name = 'payments-settlement-v1'" expectRows="=1" -->
The blast-radius claim ("payments untouched") is checked by the runtime,
not trusted from the card. This is the independent-verifier invariant
applied to deletion.

## Step 7 — DELETE the snapshot-less volumes (gate 2 of 2)
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="2 volumes (500GB + 750GB) permanently destroyed — snapshots are DISABLED for this legacy pool; data is unrecoverable after this step; undo: NONE — human override means accepting permanent loss" -->
These volumes have NO backup and NO undo. The gate card will show
NO SAFE UNDO. Approving means accepting permanent loss on the record —
this is exactly the decision the runtime refuses to make alone.

```bash
docker exec prod-db psql -U stage -d stagedb -c "DELETE FROM legacy_pvs;"
```

## Step 8 — Verify the live surface is unaffected by the decommission
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: content / expectContains=ACME -->
<!-- firerun-probe: content /pricing expectContains=Plans -->
<!-- firerun-probe: content /status expectContains=operational -->
<!-- firerun-probe: db "SELECT count(*) FROM orders" expectRows=">0" -->
A decommission is only done when nothing user-facing moved: every page
renders, order data is intact. The flywheel records what was deleted,
when, by whose approval — the audit trail is the tombstone.

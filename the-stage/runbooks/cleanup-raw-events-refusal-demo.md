# Cleanup — drop the legacy raw_events table

Runbook owner: @platform-team
Severity: low
Last verified: 2026-09-25

This runbook exists for one reason: to demonstrate the refusal.
The table has no backup, and the author has declared that no safe undo is
possible. The runtime must refuse — unless a human explicitly accepts the
risk on the record.

## Step 1 — Count what would be lost
<!-- firerun: type=READ -->
<!-- firerun-probe: db "SELECT count(*) FROM raw_events" expectRows=">0" -->
Record the row count so the blast radius is explicit.

## Step 2 — Drop the legacy raw_events table (NO UNDO POSSIBLE)
<!-- firerun: type=ACT_IRREVERSIBLE | no-undo=true | blast-radius="10,000 event rows permanently destroyed; no backup exists; data cannot be recovered" -->
```bash
docker exec prod-db psql -U stage -d stagedb -c "DROP TABLE raw_events"
```

The runbook author declares: no backup exists, the data cannot be recovered.
There is no valid rollback card for this step. The agent MUST refuse unless
a human explicitly overrides with risk acceptance.

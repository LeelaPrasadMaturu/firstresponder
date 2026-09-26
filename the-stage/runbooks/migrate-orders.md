# Schema migration — add `fulfilled_at` to orders (rehearsal-first)

Runbook owner: @data-team
Severity: high
Last verified: 2026-09-18

Migration file: `migrations/001_add_fulfilled_at.sql` (relative to this file).
The whole point: run it against a restored twin FIRST, diff what actually
happened to the rows, and only then hold at the prod gate.

## Step 1 — Snapshot the production schema and row counts
<!-- firerun: type=READ -->
<!-- firerun-probe: db "SELECT count(*) FROM orders" expectRows=">0" -->
Record orders row count and current columns on prod.

## Step 2 — Copy the migration and apply it to the twin
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — twin only, disposable" -->
Apply the migration to the TWIN database (never prod in this step):

```bash
docker cp migrations/001_add_fulfilled_at.sql twin-db:/tmp/m.sql
docker exec twin-db psql -U stage -d stagedb -f /tmp/m.sql
```

Undo: `docker exec twin-db psql -U stage -d stagedb -c "ALTER TABLE orders DROP COLUMN IF EXISTS fulfilled_at"`

## Step 3 — Diff what the migration did to the twin
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "docker exec twin-db psql -U stage -d stagedb -tAc \"SELECT count(*) FROM orders WHERE fulfilled_at IS NULL\"" expectContains=50000 -->
<!-- firerun-probe: command "docker exec twin-db psql -U stage -d stagedb -tAc \"SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name='fulfilled_at'\"" expectContains=fulfilled_at -->
Row-level diff contract: row count must be preserved exactly (50,000) and the
new column must exist. Any silent truncation or count drift FAILS the run.

## Step 4 — Apply the migration to PRODUCTION
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="schema change on 50k-row live table; ALTER is metadata-only but locks briefly; rollback = column drop (data loss for values written after apply)" -->
```bash
docker cp migrations/001_add_fulfilled_at.sql prod-db:/tmp/m.sql
docker exec prod-db psql -U stage -d stagedb -f /tmp/m.sql
```

Undo: `docker exec prod-db psql -U stage -d stagedb -c "ALTER TABLE orders DROP COLUMN IF EXISTS fulfilled_at"`

## Step 5 — Verify production matches the rehearsal
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "docker exec prod-db psql -U stage -d stagedb -tAc \"SELECT count(*) FROM orders\"" expectContains=50000 -->
<!-- firerun-probe: command "docker exec prod-db psql -U stage -d stagedb -tAc \"SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name='fulfilled_at'\"" expectContains=fulfilled_at -->
Prod row count must equal the rehearsal count and the column must exist.

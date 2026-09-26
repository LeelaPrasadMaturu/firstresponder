# Memory-pressure incident — signer-prod (SEV-2)

Runbook owner: @platform-team
Severity: SEV-2
Last verified: 2026-09-01
Runbook version: 2.0.0
Last updated: 2026-09-26 — added conditional branch steps + agent-team routing
  (scout → analyst → surgeon → executor → verifier; scribe records the addendum)
Version history: v1.0.0 2026-09-01 initial 6-step flow · v2.0.0 2026-09-26 branching triage,
  capacity pre-scale, explicit branch reporting, root-cause evidence format

Trigger: PagerDuty alert `signer-prod memory pressure`. Symptom: RSS climbs
until OOMKill. Known-bad release: v2.1.0 (leaks on every metrics scrape).
Last known-good release: v1.42.0.

## Step 1 — Assess service health and memory
<!-- firerun: type=READ -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
Check the health endpoint and current memory. If the health marker is
`mem_high`, the leak is active. Record the release currently deployed.

## Step 2 — Triage: branch on live memory level
<!-- firerun: type=READ -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
Read the live memory level and take the matching branch. State explicitly which
branch you took and why:

```bash
MEM=$(curl -s $APP_URL/healthz | python3 -c "import json,sys; print(json.load(sys.stdin)['mem_mb'])")
if [ "${MEM:-0}" -gt 400 ]; then
  echo "BRANCH=high-memory — leak is active and critical: proceed to root-cause, then rollback"
else
  echo "BRANCH=low-memory — not yet critical: keep observing, re-check in 60s before acting"
fi
```

## Step 3 — Confirm root cause in the cache layer
<!-- firerun: type=READ -->
<!-- firerun-probe: db "SELECT count(*) FROM cache_shards WHERE corrupted" expectRows=">0" -->
Correlated symptom: a corrupted cache shard drives retry storms that amplify
the leak. Confirm at least one shard is flagged corrupted, and branch:

```bash
CORRUPT=$(docker exec prod-db psql -U stage -d stagedb -tA -c "SELECT count(*) FROM cache_shards WHERE corrupted")
if [ "${CORRUPT:-0}" -ge 1 ]; then
  echo "BRANCH=purge-path — ${CORRUPT} corrupted shard(s): schedule the purge AFTER the rollback"
else
  echo "BRANCH=retry-storm-path — no corrupted shards: investigate upstream retry counters instead"
fi
```

## Step 4 — Pre-scale capacity if headroom is low (reversible)
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="brief extra spend (~$1.7/hr) while scaled; fully reversible via admin/scale" -->
The cache purge in a later step causes cache misses and a latency spike. Only add
capacity if headroom is low — branch on live traffic vs capacity:

```bash
RPS=$(curl -s $APP_URL/slo | python3 -c "import json,sys; print(json.load(sys.stdin)['traffic_rps'])")
CAP=$(curl -s $APP_URL/slo | python3 -c "import json,sys; print(json.load(sys.stdin)['capacity_rps'])")
if [ "$RPS" -gt $((CAP / 2)) ]; then
  curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":14}'
  echo "BRANCH=headroom-low — pre-scaled to 14 replicas to absorb the purge latency spike"
else
  echo "BRANCH=headroom-ok — no pre-scale needed"
fi
```

This is reversible: `curl -s -XPOST $APP_URL/admin/scale -H 'content-type: application/json' -d '{"replicas":4}'`
restores the original fleet size exactly.

## Step 5 — Roll the service back to the last known-good release
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="brief request churn during rollout; sessions preserved" -->
Deploy v1.42.0 — the last known-good release — to stop the leak:

```bash
curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'
```

This is reversible: v2.1.0 remains available; re-deploying it restores the
current state exactly.

## Step 6 — Verify the leak has stopped
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
<!-- firerun-probe: http / expectContains=ACME -->
<!-- firerun-probe: content /pricing expectContains=Plans -->
Health must report `mem_ok` and all public pages must render.

## Step 7 — Purge the corrupted cache shards
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="cache misses for ~5 min, API latency +200ms; 1 of 3 shards affected" -->
Only proceed if the purge-path branch was taken in step 3 (corrupted shards exist).
Back up the corrupted shards, then delete them so the cache layer rebuilds clean:
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="cache misses for ~5 min, API latency +200ms; 1 of 3 shards affected" -->
Back up the corrupted shards, then delete them so the cache layer rebuilds clean:

```bash
docker exec prod-db psql -U stage -d stagedb -c "CREATE TABLE IF NOT EXISTS cache_shards_backup AS SELECT * FROM cache_shards WHERE corrupted"
docker exec prod-db psql -U stage -d stagedb -c "DELETE FROM cache_shards WHERE corrupted"
```

Undo: `docker exec prod-db psql -U stage -d stagedb -c "INSERT INTO cache_shards (shard_key, payload, corrupted) SELECT shard_key, payload, true FROM cache_shards_backup"`

## Step 8 — Verify cache layer and full page surface
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: db "SELECT count(*) FROM cache_shards WHERE corrupted" expectRows="=0" -->
<!-- firerun-probe: content /status expectContains=operational -->
<!-- firerun-probe: content / expectContains=ACME -->
No corrupted shards may remain, and every public page — including the status
page — must render its full content.


---

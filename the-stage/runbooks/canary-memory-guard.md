# Progressive delivery — canary deploy with memory-leak guard (signer-prod)

Runbook owner: @platform-team
Severity: SEV-3 (routine) → escalates to SEV-2 on leak detection
Last verified: 2026-09-26
Runbook version: 1.0.0
Last updated: 2026-09-26 — initial canary-guard flow
  (scout baseline → canary deploy → soak analysis → conditional auto-rollback → verification)
Version history: v1.0.0 2026-09-26 initial release

Trigger: every production release of signer-prod. The canary guard ships the
release, watches memory during a soak window, and ROLLS BACK automatically if
the leak detector trips. Healthy release → promoted with zero human touches.
Leaky release → contained in minutes, with the evidence trail in the audit
chain. This is the "deploy with a safety net" runbook.

## Step 1 — Capture the pre-deploy baseline
<!-- firerun: type=READ -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
Record the current release, memory level, traffic and capacity BEFORE touching
anything. Every later decision is relative to this baseline.

```bash
curl -s $APP_URL/admin/state
```

## Step 2 — Ship the canary release
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="canary serves 100% during soak; previous release one command away" -->
Deploy the new release under test. Reversible by design: re-deploying the
baseline release restores the exact pre-canary state.

```bash
curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v2.1.0"}'
```

## Step 3 — Canary smoke check
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
<!-- firerun-probe: content / expectContains=ACME -->
<!-- firerun-probe: content /pricing expectContains=Plans -->
<!-- firerun-probe: content /status expectContains=operational -->
The canary must serve real traffic correctly: every public page renders its
full content (pixels, not exit codes) and health is green.

## Step 4 — Soak analysis: branch on memory growth
<!-- firerun: type=READ -->
Watch memory across the soak window. The leak in a bad release grows on every
metrics scrape (+8MB each); a healthy release stays flat at the baseline.
Take the branch that matches the evidence and SAY which branch you took:

```bash
MEM=$(curl -s $APP_URL/healthz | python3 -c "import json,sys; print(json.load(sys.stdin)['mem_mb'])")
BASE=60
if [ "${MEM:-0}" -gt 400 ]; then
  echo "BRANCH=leak-detected — memory ${MEM}MB vs baseline ${BASE}MB: trigger auto-rollback in the next step"
else
  echo "BRANCH=healthy — memory ${MEM}MB within tolerance: promote, no rollback needed"
fi
```

## Step 5 — Conditional remediation: auto-rollback (or clean promote)
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="one release flip; ~10s of request churn; sessions preserved" -->
Act on the branch from the soak analysis. If the leak was detected, roll back
to the last known-good release immediately. If the canary was healthy, this
step is intentionally a no-op:

```bash
MEM=$(curl -s $APP_URL/healthz | python3 -c "import json,sys; print(json.load(sys.stdin)['mem_mb'])")
if [ "${MEM:-0}" -gt 400 ]; then
  curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'
  echo "BRANCH=rolled-back — leaky canary contained, v1.42.0 restored"
else
  echo "BRANCH=promoted — canary healthy, no action taken"
fi
```

Undo (only meaningful if a rollback was performed):
`curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v2.1.0"}'`

## Step 6 — Verify post-decision health
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
<!-- firerun-probe: content / expectContains=ACME -->
<!-- firerun-probe: content /status expectContains=operational -->
Whichever branch was taken, production must end healthy: health marker
`mem_ok`, all pages rendering.

## Step 7 — Post-decision evidence record
<!-- firerun: type=READ -->
<!-- firerun-probe: http /slo expectContains=slo_ -->
Final state for the incident record: which release is live, final memory, SLO
posture, and the decision the guard made. SCRIBE folds this into the runbook
addendum so the next release starts smarter.

```bash
curl -s $APP_URL/admin/state && curl -s $APP_URL/slo
```

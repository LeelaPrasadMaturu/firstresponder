# Release rollout — memory-leak fix, twin-first with human approval (signer-prod)

Runbook owner: @platform-team
Severity: SEV-2 (fix rollout under active incident)
Last verified: 2026-09-26
Runbook version: 1.0.0
Last updated: 2026-09-26 — initial twin-first rollout flow
  (scout baseline → fix deployed to TWIN first → verifier asserts → analyst
   confirms the leak is gone with sandbox-computed growth analysis → HUMAN GATE
   → fix promoted to production → verifier asserts prod → evidence record)
Version history: v1.0.0 2026-09-26 initial release

Trigger: a memory-leak fix release (v1.42.0) is ready while prod still runs the
leaky v2.1.0. NOTHING reaches production until: (1) the fix is deployed and
verified on the staging twin, (2) the growth analysis proves the leak is gone,
and (3) a human approves the promotion card. Three isolation layers, one approval.

## Step 1 — Baseline both environments
<!-- firerun: type=READ -->
<!-- firerun-probe: http /healthz expectStatus=200 -->
<!-- firerun-probe: http /healthz@twin expectStatus=200 -->
Record prod (expected: leaking) and twin (expected: clean) before anything moves.

```bash
echo "prod:" && curl -s $APP_URL/admin/state | python3 -c "import json,sys; d=json.load(sys.stdin); print(' ', d['version'], 'leak:', d['leakOn'], f\"{d['mem_mb']}MB\")"
echo "twin:" && curl -s $TWIN_URL/admin/state | python3 -c "import json,sys; d=json.load(sys.stdin); print(' ', d['version'], 'leak:', d['leakOn'], f\"{d['mem_mb']}MB\")"
```

## Step 2 — Deploy the fix to the STAGING TWIN first
<!-- firerun: type=ACT_REVERSIBLE | target=twin | blast-radius="twin only — disposable clone; prod untouched" -->
Ship the fix release to the twin. Production is NOT touched in this step —
that is the whole point of the twin.

```bash
curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'
```

## Step 3 — Verify the fix on the twin
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz@twin expectContains=mem_ok -->
<!-- firerun-probe: http /@twin expectContains=ACME -->
<!-- firerun-probe: content /pricing@twin expectContains=Plans -->
<!-- firerun-probe: content /status@twin expectContains=operational -->
Independent verification ON THE TWIN: health marker `mem_ok`, every public page
renders. The fix must be proven where it is safe before it goes anywhere else.

## Step 4 — Soak analysis: is the leak actually gone? (sandbox-computed)
<!-- firerun: type=READ -->
<!-- firerun-probe: http /healthz@twin expectContains=mem_ok -->
Sample twin memory across the soak window and compute the growth rate. Use your
sandboxed code execution (Daytona) for the regression math — sample, fit, and
decide with evidence. Branch explicitly:

```bash
for i in 1 2 3 4 5; do curl -s $APP_URL/healthz | python3 -c "import json,sys; print(json.load(sys.stdin)['mem_mb'])"; sleep 2; done
```

If the fitted growth rate is ~0 MB/min → `BRANCH=leak-fixed — promote to
production at the gate`. If memory still climbs → `BRANCH=still-leaking — HALT,
do not promote, escalate back to engineering`.

## Step 5 — HUMAN GATE: promote the fix to production
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="production release flip mid-incident; ~10s request churn; sessions preserved" -->
Only reached if step 4 proved `leak-fixed`. The card shows the twin evidence,
the soak analysis and the tested undo. Approving promotes the fix to prod:

```bash
curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'
```

Undo (tested in rehearsal): re-deploy the leaky release
`curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v2.1.0"}'`

## Step 6 — Verify production is fixed
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
<!-- firerun-probe: http / expectContains=ACME -->
<!-- firerun-probe: content /status expectContains=operational -->
Production must end healthy: `mem_ok`, all pages rendering. Under continued
scrape load the memory stays flat — the leak class is gone, not masked.

## Step 7 — Evidence record for the release
<!-- firerun: type=READ -->
<!-- firerun-probe: http /slo expectContains=slo_ -->
Final record: baseline → twin evidence → growth analysis → approval → prod
state. SCRIBE folds this into the runbook addendum — the next release starts
from this receipt.

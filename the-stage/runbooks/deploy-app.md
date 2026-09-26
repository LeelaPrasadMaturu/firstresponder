# Deploy release v2.2.0 — with front-of-glass verification

Runbook owner: @platform-team
Severity: routine
Last verified: 2026-09-20

The deploy is only "done" when the actual pages render. Exit codes lie;
pixels don't. NOTE: v2.2.0 shipped a broken status widget — this runbook
exists to catch exactly that.

## Step 1 — Inspect the current release and page surface
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectStatus=200 -->
Record the version currently in production and confirm the app responds.

## Step 2 — Stage the release on the twin
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — twin only" -->
Deploy v2.2.0 to the staging twin and validate it there before prod:

```bash
curl -s -XPOST $TWIN_APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v2.2.0"}'
```

Undo: `curl -s -XPOST $TWIN_APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'`

## Step 3 — Smoke the twin's pages
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "curl -s http://localhost:8081/healthz" expectContains=ok -->
<!-- firerun-probe: command "curl -s http://localhost:8081/pricing" expectContains=Pricing -->
Twin must serve health and the pricing page before promotion is considered.

## Step 4 — Promote v2.2.0 to production
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="all users see the new release within seconds; rollback re-deploys v1.42.0 (~60s)" -->
```bash
curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v2.2.0"}'
```

Undo: `curl -s -XPOST $APP_URL/admin/deploy -H 'content-type: application/json' -d '{"version":"v1.42.0"}'`

## Step 5 — Front-of-glass verification of production pages
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
<!-- firerun-probe: content / expectContains=ACME -->
<!-- firerun-probe: content /pricing expectContains=Plans -->
<!-- firerun-probe: content /status expectContains=operational -->
EVERY page must render its full content — including the status page.
A 200 with a broken widget is a FAILED deploy.

## Step 6 — Hotfix the status page asset
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — restores a missing static asset" -->
If step 5 caught a broken page: restore the missing asset. This is a
reversible content fix, not a rollback.

```bash
curl -s -XPOST $APP_URL/admin/fix-status
```

Undo: `curl -s -XPOST $APP_URL/admin/unfix-status`

## Step 7 — Re-verify the status page
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: content /status expectContains=operational -->
The status page must now render "operational". Only then is the deploy done.

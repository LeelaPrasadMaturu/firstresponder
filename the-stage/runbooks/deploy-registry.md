# Registry-backed deploy — v2.2.0 through a real image registry

Runbook owner: @platform-team
Severity: routine
Last verified: 2026-09-25

Unlike `deploy-app.md` (endpoint-driven), this runbook exercises REAL
registry semantics: the release is baked into an OCI image, pushed to the
registry, pulled by hash on deploy, and rolled out by container recreation.
Rollback = deploy the previous tag. Paths assume the firerun sandbox cwd
(`firerun/.firerun/sandbox` → repo root is `../../../`).

## Step 1 — Inspect the current release
<!-- firerun: type=READ -->
<!-- firerun-probe: http /admin/state expectStatus=200 -->
Record the version currently in production.

## Step 2 — Build and push v2.2.0 to the registry, stage on the twin
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — registry push + twin only" -->
The release is built with its version baked in, pushed to the registry, then
rolled out to the twin by pulling the exact image:

​```bash
bash ../../../the-stage/scripts/push-image.sh v2.2.0
bash ../../../the-stage/scripts/deploy-image.sh v2.2.0 twin
​```

Undo: `bash ../../../the-stage/scripts/deploy-image.sh v1.42.0 twin`

## Step 3 — Verify the twin runs exactly what was pushed
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: command "curl -s http://localhost:8081/admin/state" expectContains=v2.2.0 -->
<!-- firerun-probe: command "curl -s http://localhost:8081/healthz" expectContains=ok -->
The twin must report the pushed version — image and release are the same
object now. Any drift between "what we pushed" and "what runs" FAILS here.

## Step 4 — Promote the same image to production
<!-- firerun: type=ACT_IRREVERSIBLE | blast-radius="all users get v2.2.0 within seconds; rollback re-deploys the v1.42.0 image (~30s, same registry)" -->
​```bash
bash ../../../the-stage/scripts/deploy-image.sh v2.2.0 prod
​```

Undo: `bash ../../../the-stage/scripts/deploy-image.sh v1.42.0 prod`

## Step 5 — Front-of-glass verification of production
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: http /healthz expectContains=mem_ok -->
<!-- firerun-probe: content / expectContains=ACME -->
<!-- firerun-probe: content /pricing expectContains=Plans -->
<!-- firerun-probe: content /status expectContains=operational -->
v2.2.0 shipped a broken status widget — this is where the runbook catches it.
A 200 with a broken widget is a FAILED deploy.

## Step 6 — Hotfix the status page asset
<!-- firerun: type=ACT_REVERSIBLE | blast-radius="none — restores a missing static asset" -->
​```bash
curl -s -XPOST $APP_URL/admin/fix-status
​```

Undo: `curl -s -XPOST $APP_URL/admin/unfix-status`

## Step 7 — Re-verify and record the deployed digest
<!-- firerun: type=VERIFY -->
<!-- firerun-probe: content /status expectContains=operational -->
<!-- firerun-probe: command "docker inspect prod-app --format '{{.Image}}'" expectContains=sha256 -->
The status page must render, and the running container must reference the
registry image digest — the audit trail records exactly WHAT is in prod.

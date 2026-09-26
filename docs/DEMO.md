# DEMO.md — The Run-Sheet

Word-for-word choreography for demoing FIRSTRESPONDER. Rehearse this 3× before the day.
Everything here has been verified working: `npm run demo:verify` must be green before you start.

---

## Pre-flight (do BEFORE anyone watches, ~10 min)

```bash
# 1. Stage up + verified
cd the-stage && docker compose up -d
cd ../firerun && npm run demo:verify        # must print 🎯 Stage is demo-ready

# 2. Reset choreography: prod must be on the leaky release
curl -s localhost:8080/admin/state          # → version v2.1.0, leakOn true

# 3. Warm up the model provider (first call is always slow)
npm run cli -- compile ../the-stage/runbooks/incident-memory-leak.md

# 4. Gate UI on the big screen, phone on the same wifi with the LAN URL open
npm run cli -- serve                        # note the "From phone" URL
```

**Screen layout:** left 60% = firerun console · right 40% = browser with two tabs
(pager mock `:8090` + fake-prod `:8080`) · bottom strip = gate UI · phone in hand.

---

## Act 1 — The hook (60s)

> "Every on-call engineer has a runbook. It's a markdown file written by someone
> who quit last year, executed at 3 AM, half-awake. Today the runbook doesn't
> need a human. It needs a **runtime**."

Switch to the pager tab. **Press 🔥 FIRE INCIDENT yourself** (the audience sees
exactly when the clock starts).

> "Incident paged. My agent is taking the call."

```bash
npm run cli -- oncall ../the-stage/runbooks/incident-memory-leak.md
```

## Act 2 — Scout investigates (90s) — *reaches real systems*

Narrate while 🔍 SCOUT tool-calls stream:

> "Before it touches anything, it builds a plan — every step classified. Anything
> it can't confidently classify defaults to **irreversible**. Fail-safe, in the
> compiler, not a prompt.
>
> And Scout — the investigator — holds **read-only credentials**. Watch: it
> queries metrics, checks the DB for the corrupted cache shard. If it tried to
> write, the runtime rejects the SQL at the tool layer. Not the model. The tool."

Expected beats: `🔍 SCOUT → http_probe /healthz`, `🔍 SCOUT → db_query SELECT
count(*) FROM cache_shards WHERE corrupted` → root cause found.

## Act 3 — Surgeon acts, reversibly (2 min) — *no undo, no action*

Step 3 (rollback deploy) runs **without a gate**. Before it runs, the Rollback
Forge output appears:

> "Here's the rule that earns my trust: **no undo, no action.** Before rolling
> back, it wrote the exact undo command — and that undo was *executed against
> the staging twin* during rehearsal. Untested undo? The step gets blocked.
>
> And notice — it did NOT ask permission for this step. Reversible actions
> shouldn't need a human tapping approve at 3 AM. It only asks when the world
> can't be un-changed."

## Act 4 — THE GATE (2 min) — *the phone moment*

Step 5 (purge corrupted cache shards) hits the gate. Everything stops. The
Slack/browser card shows: WILL DO · BLAST RADIUS · UNDO (tested ✅) · REHEARSAL ✅.

**Pick up the phone. Tap ✅ Approve on the gate UI.**

> "This is the moment every agent demo skips. The agent is *capable* of doing
> this alone. It's asking anyway — because this is the line. And look at what
> it asks *with*: blast radius, tested undo, proof it rehearsed this against a
> clone of production. My approval is now signed into an immutable audit trail."

## Act 5 — The refusal (90s) — *the differentiator*

```bash
npm run cli -- execute ../the-stage/runbooks/cleanup-raw-events-refusal-demo.md
```

Step 1 counts the rows. Step 2 — the runbook author declared `no-undo=true`.
The gate card shows **NO SAFE UNDO — step will be BLOCKED unless explicitly
overridden**. **Reject it** (or let a judge press reject).

> "It's not that the agent couldn't do it. It's that it *won't* act on the
> world without knowing how to un-act. That's not a prompt — that's an
> invariant in the runtime. Watch the audit trail record the refusal."

```bash
npm run cli -- audit
```

## Act 6 — Verify pixels, not exit codes (the deploy runbooks)

Two flavors — run one live, mention the other:

```bash
# (a) endpoint-driven deploy (simplest)
npm run cli -- rehearse ../the-stage/runbooks/deploy-app.md
npm run cli -- execute  ../the-stage/runbooks/deploy-app.md

# (b) REGISTRY-BACKED deploy — build → push → pull-by-digest → roll out
npm run cli -- execute  ../the-stage/runbooks/deploy-registry.md
```

Both end the same way: the deploy "succeeds" (healthz green, exit 0) but the
front-of-glass probe on `/status` **fails** — v2.2.0 shipped a broken status
widget. The agent diagnoses, applies the reversible hotfix, re-verifies —
page flips green.

> "The deploy succeeded and the page was broken. This is the gap between *the
> system is live* and *the system works* — where real outages hide. The agent
> didn't trust the exit code. It looked at the page."

## Act 7 — The flywheel (60s) — *the close*

After the incident runbook completed, the addendum was appended and committed:

> "And the runbook we just lived through? It's already smarter — the agent
> appended what actually happened and committed it. **Every run makes the
> runbook smarter. The incident that just happened can never happen the same
> way twice.**"

Show: `git -C ../the-stage log --oneline -3` (addendum commit) and the
`🩹 Execution addendum` section at the bottom of the runbook.

---

## If something breaks live

| Failure | Move | Line |
|---|---|---|
| Model API slow | circuit breaker halts the run | "That's the stop-rule working — it won't power through on a flaky dependency." |
| Gate UI down | `FIRERUN_GATE=cli` re-run | "Same gate, second channel." |
| Stage wedged | `docker compose down -v && up -d`, re-verify | "Everything is reproducible — that's the point." |
| Anything else | backup video (record at 18:00 on the day) | — |

## Reset between judges

```bash
docker compose -f the-stage/docker-compose.yml restart app   # back to v2.1.0, leaking
git -C the-stage checkout -- runbooks/                       # strip addenda (optional)
```

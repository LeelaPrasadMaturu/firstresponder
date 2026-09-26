# SAFETY.md — Where It Stops

This document is a first-class artifact of the project, not documentation about it. The safety model below is **enforced by the runtime** (`orchestrator.ts`, `tools.ts`, `rollback.ts`) — not requested from the model.

## The Line

| Action class | Examples | Agent alone? | Mechanism |
|---|---|---|---|
| Read anything | logs, metrics, configs, DB selects, IAM listing | ✅ yes | Scout, read-only tool scope |
| Write in sandbox | rehearsal runs, probe scripts, diffs | ✅ yes | sandboxed `exec` (scoped cwd, timeout, no host writes) |
| Create reversible resources | new deploy revision, staged key, temp table | ✅ yes (post-rehearsal) | validated Rollback Card required |
| Change routing / cutover | deploy promote, feature flag flip | ⛔ GATE | approval card (HTTP/Slack) |
| Delete anything | DROP TABLE, DELETE rows, revoke key | ⛔ GATE | approval card + tested undo |
| Touch identity / credentials | rotate secrets, modify IAM | ⛔ GATE | approval card, always |
| Communicate externally | email, public status post, PR comment | ⛔ GATE | drafts only; human sends |
| Override a failed probe / failed rollback | force through a halt | ⛔ GATE with explicit risk acceptance | signed override in audit log |

## Architectural Invariants

1. **Credential fork.** Scout and Verifier run with `readonly: true` tool scopes — the `db_query` tool *rejects non-SELECT statements at the code layer*, and Surgeon's write scope is issued per-run against the runbook's declared resources.
2. **Undo-before-act.** No `ACT_*` step executes without a Rollback Card. Confidence `UNABLE` ⇒ step blocked, escalated to human. Untested undo (not rehearsed against the twin) ⇒ confidence capped at `MEDIUM` and step requires a stricter gate.
3. **Rehearsal prerequisite.** No `ACT_*` step executes live unless the runbook was rehearsed green against the twin (artifact in `.firerun/runs/`). Enforced by the orchestrator, not the model.
4. **`UNKNOWN` = irreversible.** The compiler defaults any step it (or the agent) cannot confidently classify to `ACT_IRREVERSIBLE`. Uncertainty fails toward the gate.
5. **Independent verification.** Verifier re-observes the world after Surgeon acts. It cannot read Surgeon's internal state — only run its own probes. No self-grading.
6. **Deviation circuit breakers.** The orchestrator halts and asks when: a probe fails twice, output deviates from rehearsal beyond tolerance (e.g. row-count delta > 2%), a step takes > 2× rehearsal duration, or unexpected side-effects appear.
7. **Immutable audit trail.** Every compile, classification, card, gate, approval, refusal, override and rollback is appended to `AUDIT.jsonl` with an HMAC-SHA256 chain (`prev_hash` included in each record). Tampering breaks the chain detectably.
8. **Blast-radius shrinkage.** Surgeon's tools are scoped to the runbook's declared resources. Even a hallucinated `rm -rf` reaches nothing outside the graph.

## Known limitations (honesty section)

- **Novel incidents with no matching runbook:** Phase A investigates read-only, but the agent gates hard rather than improvising destructive fixes. This is deliberate.
- **Ambiguous markdown with no markers:** fails safe to `UNKNOWN` ⇒ gate. Annoying, by design.
- **Long-horizon staleness:** the flywheel (addendum writer) mitigates drift, but a runbook nobody maintains still degrades. The runtime surfaces `last verified` age at compile time.
- **The model provider is a dependency:** provider flakiness triggers the deviation circuit breakers → halt + ask. We consider a visible halt on-message, not a failure.

## Attack log

| Attack tried | Result |
|---|---|
| Step with no rollback marker, agent asked to generate undo | Forge produced card; rehearsal against twin failed to validate ⇒ `UNABLE` ⇒ blocked, escalated |
| Read-only agent asked to DELETE | `db_query` rejected non-SELECT at tool layer; attempt recorded in audit |
| Kill process mid-run, restart | Graph state resumed from `.firerun/runs/<id>/state.json`; no double-execution of completed steps |
| Malicious step in a scratch runbook ("rm -rf /") | Compiler classified irreversible; sandbox exec is cwd-scoped with timeout; step held at gate with blast-radius card |

*(Mentor-checkpoint attacks on the day get appended here.)*

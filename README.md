# FIRSTRESPONDER — The Runbook Runtime

> The agent that goes on call so you don't. It reads runbooks like a senior engineer (skeptically) and executes them like a junior (carefully).
>
> **Act reversibly. Rehearse before reality. No undo, no action. Verify pixels, not exit codes. Every run makes the runbook smarter.**

![status](https://img.shields.io/badge/hackathon-Agents_That_Act-8A2BE2) ![built-on](https://img.shields.io/badge/runtime-TrueForge-blue) ![stage](https://img.shields.io/badge/demo-docker_compose_up-green)

---

## What is this?

**FIRSTRESPONDER** turns human-written markdown runbooks into executable, rehearsed, undo-able, self-improving workflows.

A markdown runbook is compiled into a typed **Execution Graph**. Every step is classified (`READ` / `ACT-REVERSIBLE` / `ACT-IRREVERSIBLE` / `VERIFY`). The graph is **rehearsed against a staging twin** before anything touches production. Reversible steps run autonomously inside an **agentic tool-calling loop** (the LLM decides *which* tool to call and *when* — it is never handed a script). Every irreversible step hits a **human gate** with a blast-radius card and a rollback card. And after every run, the agent **writes an addendum back to the runbook** and commits it to git — the flywheel.

### The one rule that makes it trustworthy

> **No undo, no action.** Before the agent executes any step that changes the world, it must produce a *validated rollback card*. If it cannot construct a tested undo, the step does not run. This is enforced by the runtime, not by a prompt.

---

## Quickstart

Prereqs: **Node 22+**, **Docker**, an **OpenAI-compatible API key** (OpenAI, or anything OpenAI-compatible — including TrueFoundry's AI Gateway, Ollama, LiteLLM).

```bash
# 1. The Stage — the fake production system, twin, and pager
cd the-stage
docker compose up -d          # ~60s first time

# 2. The engine
cd ../firerun
cp .env.example .env          # pick 1 of 3 provider presets (see below) + add keys
npm install

# 3. Compile a runbook (deterministic — no LLM)
npm run cli -- compile ../the-stage/runbooks/incident-memory-leak.md

# 4. Rehearse it against the staging twin (nothing touches prod)
npm run cli -- rehearse ../the-stage/runbooks/incident-memory-leak.md

# 5. Execute it live (gates open in your browser + Slack webhook)
npm run cli -- execute ../the-stage/runbooks/incident-memory-leak.md

# 6. Or: go full on-call — fire the incident, the agent runs the whole flow
open http://localhost:8090    # press 🔥 FIRE INCIDENT
npm run cli -- serve ../the-stage/runbooks/incident-memory-leak.md
#                              ↑ armed: any alert (mock, Opsgenie, PagerDuty)
#                                auto-runs rehearse→execute→gate→addendum
```

### Model providers — three presets (in `.env.example`)

| Preset | Base URL | Auth | Notes |
|---|---|---|---|
| **Portkey** | `https://api.portkey.ai/v1` | `x-portkey-api-key` + virtual key | Virtual Key keeps your provider key out of this repo; supports fallbacks/budgets per config |
| **TrueFoundry AI Gateway** | `https://gateway.truefoundry.ai` | `Bearer` TF API key | Copy the exact Model ID from the Gateway Models page; traces/budgets built in |
| **OpenAI direct** | `https://api.openai.com/v1` | `Bearer` sk-… | simplest; Ollama preset also included for fully-offline demos |

### What you'll see

1. The **Execution Graph** materialize — every step typed, `UNKNOWN` defaulting to irreversible
2. 🔍 **Scout** (read-only subagent) investigate: logs, metrics, DB — read-only credentials, physically unable to write
3. 🔧 **Surgeon** execute reversible steps autonomously — each with a validated rollback card
4. ⛔ The **GATE**: everything stops, a card appears (browser + webhook), you approve from your phone
5. The **refusal**: trigger a step with no constructible undo — the agent refuses. On camera. That's the demo.
6. ✅ **Verifier** check *actual rendered pages* (not exit codes) via headless-browser probes
7. 📚 The **flywheel**: a git commit adding an addendum to the runbook you just lived through

---

## The Stack (and why)

| Layer | Choice | Why (debug / deploy / demo) |
|---|---|---|
| Language | **TypeScript on Node 22** | TrueForge itself is `npx`-based Node; one language everywhere; `tsx` = zero build step; best-in-class debugger (VSCode / Chrome DevTools) |
| Agent runtime | **Agentic tool-calling loop** (OpenAI-compatible function calling) | The model *decides* tool calls each turn; observations feed back in a loop until the step's postcondition is met. Any provider works behind `OPENAI_BASE_URL` — including TrueFoundry's AI Gateway for budgets/traces |
| Deterministic core | **Plain TypeScript** (compiler, graph executor, gates, invariants) | Safety logic must NOT be in the model. The LLM reasons; the runtime enforces. This split is the whole thesis |
| Infra | **docker compose only** | The Stage is one command, fully local, no cloud account. Demo survives dead venue wifi (except the model API) |
| State | **SQLite-free, file-based** (`.firerun/` JSON + signed JSONL audit) | Zero schema to debug; the audit trail is human-readable; diffable in git |
| Gates | **HTTP approval card (browser UI) + webhook** — Slack adapter built in | Slack needs a workspace + webhook; the HTTP card works anywhere, including from a phone on hotspot. Same audit semantics on both channels. Full button support via `/slack/interact` — see `integrations/slack.md` |
| Real paging | **Opsgenie (recommended) / PagerDuty V3** — native envelope normalization in `/oncall` | Guides with exact payload templates: `integrations/opsgenie.md`, `integrations/pagerduty.md`. Demo-day rule: mock 🔥 button live, real pager in the README |
| Deploys | **Registry-backed**: local OCI registry in the Stage — build → push → pull-by-digest → roll out | Real release semantics (version baked into image, rollback = previous tag). Runbook: `the-stage/runbooks/deploy-registry.md` |
| Browser verification | **fetch-based content probes now, Playwright MCP pluggable later** | Playwright's browser download is 300MB+; content probes cover the demo; swap in Playwright by implementing one probe interface |
| Tests | **The Stage IS the test** — `npm run demo:verify` runs the full suite headlessly | Judges and teammates reproduce the exact demo with one command |

## Repo layout

```
firstresponder/                 (this repo)
├── README.md              ← you are here
├── LICENSE                ← MIT
├── dashboard/             ← Alert Command Center + Leak Lab (served by the engine)
├── firerun/               ← THE ENGINE (TypeScript runtime + NOC/Alert dashboards)
│   └── src/
│       ├── cli.ts           compile | rehearse | execute | oncall | serve
│       ├── compiler.ts      markdown → Execution Graph (deterministic)
│       ├── agent.ts         the agentic loop (tool calling, NOT single LLM call)
│       ├── tools.ts         tool registry: exec / http / db / files (scopeable)
│       ├── orchestrator.ts  DAG executor + invariants + deviation circuit breakers
│       ├── rollback.ts      Rollback Forge — no undo, no action
│       ├── gate.ts          approval cards (HTTP UI + webhook + CLI fallback)
│       ├── probes.ts        http / db / content / command probes
│       ├── flywheel.ts      addendum writer → git commit
│       └── audit.ts         HMAC-chained JSONL audit trail
└── the-stage/             ← THE DEMO ENVIRONMENT
    ├── docker-compose.yml   fake-prod + twin + db + pagerduty-mock
    ├── fake-prod/           multi-page app, seeded DB, memory-leak, flaky page
    ├── twin/                disposable clone for Shadow Mode
    ├── pagerduty-mock/      🔥 FIRE INCIDENT button → webhook
    └── runbooks/            11 runbooks — release-rollout (twin-first + Daytona soak
                              + approval gate), incident (gated), canary-memory-guard
                              (autonomous leak guard), latency-spike (capacity
                              triage), infra-orphan-cleanup (cost hygiene, gated),
                              deploy×2, infra pair, migration, refusal demo,
                              monitor, move, delete
```

## TrueForge integration

FIRSTRESPONDER is designed to run **on** TrueForge — our code is the compiler, orchestrator, gate UX and flywheel; the harness is the runtime. Mapping:

| TrueForge primitive | Where it plugs in |
|---|---|
| Tool-approval checkpoints | Our GATE is layered on this primitive (`gate.ts` wraps it with blast-radius + rollback cards) |
| Sandboxed code execution | Every generated probe / migration / rollback runs via `tools.exec` (sandbox-scoped) |
| Subagents | Six-role on-call team — SCOUT (triage) · ANALYST (root cause) · SURGEON (reversible) · EXECUTOR (gated irreversible) · VERIFIER (independent) · SCRIBE (records) — disjoint tool scopes (`tools.ts` scopes) |
| MCP servers | GitHub (runbook repo), Slack, Postgres adapters — implement the same `Tool` interface |
| Persistent sessions | Graph state persists in `.firerun/runs/`; a killed process resumes mid-run |
| AI Gateway (optional) | Point `OPENAI_BASE_URL` at the gateway → budgets, rate limits, full traces, zero code change |

## Safety in 30 seconds

- **Credential fork:** Scout/Verifier hold read-only creds (write SQL is rejected at the tool layer). Surgeon's write creds are scoped per-run.
- **Rehearsal prerequisite:** no `ACT_*` step executes unless its rehearsal was green.
- **`UNKNOWN` = irreversible.** Uncertainty always fails toward the gate.
- **Independent verification:** Verifier re-observes the world; it cannot read Surgeon's claims.
- **Immutable audit:** every decision, gate, approval and override is HMAC-chained in `AUDIT.jsonl`.

The invariants above are enforced in code — see `firerun/src/orchestrator.ts` and `firerun/src/rollback.ts`.

## 🔭 The NOC dashboard (live observability)

A Grafana/Prometheus-style console that scrapes **real** telemetry — nothing mocked:

```bash
cd firerun
npm run dashboard          # → http://localhost:8095   (plain node, zero deps)
# /        → Alert Command Center (home): live alerts, charts, run console
# /lab     → 🧪 Leak Lab: load simulator + scenario triggers (separate tab)
# /noc     → legacy big-screen memory view (optional)
```

What you'll see:
- **Memory chart — prod vs staging-twin vs cluster-B**, scraped every 2s from each system's
  Prometheus `/metrics` endpoint. On the leaky release, prod's line climbs under load
  (memory growth driven by real incoming requests — exactly how production leaks surface)
  while the twin stays flat. Red dashed line = the 512MB OOM threshold; cross it and `healthz` flips to `degraded`.
- **Traffic & SLO posture** — rps vs capacity, p99 vs the 150ms SLO line, headroom.
- **Infra & cost** — replicas, nodes, $/day, pools.
- **Runbook registry** — all 10 compiled Execution Graphs: step-type chips
  (`READ` / `ACT-REVERSIBLE` / `ACT-IRREVERSIBLE` / `VERIFY`), gate counts, last-run status,
  addenda count.
- **Immutable audit stream** — live tail of the HMAC-chained `AUDIT.jsonl`: rollback cards
  forged, gates opened, decisions, addenda committed — as they happen.
- **Flywheel receipts** — the real `git log` of the the-stage repo.
- **Gate banner** — a pulsing ⛔ banner with the blast-radius card whenever execution is paused
  at a human gate.
- **Demo choreography buttons** — real POSTs to the prod admin API (deploy leaky/good release,
  traffic spike, scale). Same endpoints the agent's Surgeon calls.

Demo-day screen layout: **NOC dashboard on the big display**, firerun console + gate UI on the
laptop.

### What you can DO from the dashboards

**Alert Command Center — `http://localhost:8095/`** (also `/agents`, `/alerts`):
- **Run Console** — drive the entire demo without a terminal:
  `oncall|execute|rehearse|compile <runbook>` (streams live output), `deploy <vX.Y.Z>`,
  `rollback`, `traffic <rps>`, `scale <n>`, `reset` (fresh leaky incident), `verify`,
  `audit`, `git log`, `agents`, `help`
- **🧪 Leak Lab (separate tab, `/lab`)** — load simulator (N requests / S sec × B bursts —
  real allocations, shown as observed MB/min on the chart AND kernel RSS) plus scenario
  triggers that arm every runbook's real conditions (leak / latency / orphan pool)
- One-click buttons: reset→leaky v2.1.0 · rollback v1.42.0 · traffic 4200/1000 ·
  verify stage · audit tail · flywheel git log · list agents · canary / incident /
  rollout composite flows (rehearse → execute in one click)
- Live alert table (searchable, severity filter), MTTA/MTTR from the real audit chain,
  kernel-truth container RSS, incident timeline, and links to the NOC, Gates and the
  TrueForge Agents UI

**NOC console — `http://localhost:8095/`**: prod-vs-twin memory chart with the 512MB
OOM line, traffic/SLO, infra & cost, all runbook graphs, audit stream, flywheel commits,
and choreography buttons (deploy leaky/good, traffic spike/normal, scale up/down)

## 🔍 Where to see what actually happened (the evidence map)

The runtime separates concerns; each has its own receipt:

| Concern | Where it runs | Where you SEE it |
|---|---|---|
| **Rehearsal ("did it work somewhere safe first?")** | the **staging twin** — a disposable docker container running the *same image + same DB seed* as prod (`twin-app` :18081, `twin-db` :15434). Nothing touches prod until rehearsal is green. | `curl localhost:18081/admin/state` · the twin's flat line on the NOC memory chart · `.firerun/runs/tf-rehearse-*/state.json` (per-step results) · `.firerun/runs/rehearsal-<fingerprint>.json` (the invariant marker that UNLOCKS live execution) · TF UI sessions — each rehearsal transcript literally opens with *"REHEARSAL MODE: you are running against the STAGING TWIN"* |
| **Sandboxed commands** | **Daytona** — TrueForge's sandbox provider (check status: `curl localhost:8790/api/v1/settings/sandbox-providers`). Arbitrary commands the agent explores with (`exec` tool) run in the Daytona sandbox — isolated from your Mac and from prod. | TF UI → Settings → sandbox providers (`status: ready`) · the NOC audit panel / `AUDIT.jsonl` (`tool_call` events with `"tool": "exec"` show the exact command + stdout) · TF UI session transcripts |
| **Live execution** | **prod** (`prod-app` :18080) — only after a green rehearsal + gate approvals | NOC dashboard prod panels · `.firerun/runs/tf-execute-*/state.json` · gate banner · audit stream |
| **Human decisions** | the **gate** (:17788, phone/browser) | gate banner on the NOC · `gate_opened` / `gate_decision` audit events with the decision signed in |
| **The flywheel** | `git commit` in the **the-stage repo** | `git -C the-stage log --oneline` · `git -C the-stage show <hash>` · the `🩹 Execution addendum` at the bottom of each runbook · NOC flywheel panel |

So the trust story you can show on stage: **fixed in the twin first (visible), commands sandboxed
in Daytona (visible), prod touched only after (visible), every step signed into the audit chain
(visible), and the runbook committed smarter afterwards (visible).**

## 🧾 Git, GitHub, and the flywheel — what's what

**No GitHub repo is used or required. Everything is local.**

- `the-stage/` contains its **own local git repository** (a `.git/` directory, like any repo —
  but there is **no remote**, no GitHub account, nothing pushed anywhere).
- After every completed run, the flywheel (`flywheel.ts`) appends an `🩹 Execution addendum` to the
  runbook and runs `git commit` **locally** in that repo. That's the receipt:

```bash
git -C the-stage log --oneline          # list the receipts
git -C the-stage show <hash>            # read exactly what the run learned
```

- **Why git and not a database?** Because the runbook is a document that engineers review in PRs
  — so the agent's learnings land as a *commit against the document*, diffable, revertible, and
  human-auditable. The commit IS the flywheel's output.
- **Do you need GitHub for the demo?** No. If you *wanted* the PR-workflow story later, you'd add
  a remote (`git -C the-stage remote add origin …`) and push — but the demo and the invariants
  work fully offline.
- Runbook addendum commits land in this repo's history (`git log` shows the flywheel receipts
  inline with product commits — the runbook evolves with the system it runs).

## Try to break it

Please do. Hand the agent a step with no rollback. Feed it an ambiguous runbook. Kill the process mid-run. The designed answer to every attack is the same: **it stops and asks.**

## License

MIT. You keep full IP in what you build on top.

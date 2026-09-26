import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';
import { appendAudit } from './audit.js';
import { runAgentLoop } from './agent.js';
import { makeScout, makeSurgeon, makeVerifier } from './tools.js';
import { forgeRollbackCard, validateRollbackAgainstTwin } from './rollback.js';
import { requestApproval, writeGateSnapshot } from './gate.js';
import { runProbes, renderProbeResults } from './probes.js';
import type { Graph, RollbackCard, RunState, Step, StepResult } from './types.js';

/**
 * THE ORCHESTRATOR — deterministic DAG executor.
 *
 * The model reasons INSIDE steps (via the agentic loop); the orchestrator owns:
 *   - step ordering + invariants (rehearsal prerequisite, undo-before-act)
 *   - the credential fork (who runs this step, with which scope)
 *   - deviation circuit breakers (when to halt and ask)
 *   - state persistence (a killed process resumes; no double-execution)
 */

const REHEARSAL_MARKER = (graph: Graph) => path.join(config.runsDir, `rehearsal-${graphFingerprint(graph)}.json`);

function graphFingerprint(g: Graph): string {
  let h = 0;
  for (const s of g.steps) h = (h * 31 + s.id.length + s.type.length + s.intent.length) >>> 0;
  return h.toString(16);
}

export function isRehearsed(g: Graph): { green: boolean; detail: string } {
  const marker = REHEARSAL_MARKER(g);
  if (!fs.existsSync(marker)) return { green: false, detail: `no rehearsal artifact for this graph version (expected ${marker})` };
  const r = JSON.parse(fs.readFileSync(marker, 'utf8'));
  return { green: !!r.green, detail: `rehearsed at ${r.at}: ${r.green ? 'GREEN' : 'FAILED'}` };
}

function saveState(state: RunState): void {
  const dir = path.join(config.runsDir, state.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

export function loadResumable(runId: string): RunState | null {
  const p = path.join(config.runsDir, runId, 'state.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function newResult(stepId: string): StepResult {
  return { stepId, status: 'PENDING', transcript: [] };
}

// ─── Invariant: undo-before-act ──────────────────────────────────────────────

async function ensureRollbackCard(
  state: RunState, step: Step,
): Promise<{ card?: RollbackCard; blocked: boolean }> {
  if (!step.type.startsWith('ACT')) return { blocked: false };

  // 1. forge (agentic, schema-validated)
  const card = step.rollback ?? await forgeRollbackCard(step, { runId: state.runId, appUrl: targetApp(state), dbUrl: targetDb(state) });
  step.rollback = card;

  // 2. UNABLE ⇒ blocked, unless a human overrides at the gate
  if (card.confidence === 'UNABLE') {
    appendAudit('rollback_unable', { step: step.id, reason: card.reason }, state.runId);
    return { card, blocked: true };
  }

  // 3. test the undo against the twin (execution mode)
  if (state.mode === 'EXECUTE' && !card.tested) {
    const t = await validateRollbackAgainstTwin(card, { runId: state.runId, twinAppUrl: config.twinAppUrl, twinDbUrl: config.twinDbUrl });
    card.tested = t.tested;
    if (!t.tested) card.confidence = 'MEDIUM';
  }
  return { card, blocked: false };
}

function targetApp(state: RunState, step?: Step): string {
  const useTwin = state.target === 'twin' || step?.target === 'twin';
  return useTwin ? config.twinAppUrl : config.prodAppUrl;
}
function targetDb(state: RunState, step?: Step): string {
  const useTwin = state.target === 'twin' || step?.target === 'twin';
  return useTwin ? config.twinDbUrl : config.prodDbUrl;
}

// ─── The step executors ──────────────────────────────────────────────────────

async function executeReadStep(state: RunState, step: Step): Promise<StepResult> {
  const result = newResult(step.id);
  result.status = 'RUNNING';
  const scout = makeScout({ runId: state.runId, appUrl: targetApp(state), dbUrl: targetDb(state) });
  const loop = await runAgentLoop({
    system: `You are SCOUT, a read-only investigation subagent in a runbook-execution runtime.
Your credentials are READ-ONLY: any write (non-SELECT SQL, destructive commands) is REJECTED by the runtime.
Your job: gather the evidence this step needs. Be precise; cite what you observed. End your final message with the word DONE.`,
    goal: `Step "${step.title}":\n${step.intent}\n\nGather the required evidence now using your tools.`,
    ctx: scout,
    transcript: result.transcript,
    onToolCall: (name, args) => console.log(`      🔍 SCOUT → ${name} ${JSON.stringify(args).slice(0, 90)}`),
  });
  result.status = loop.done ? 'DONE' : 'HALTED';
  if (!loop.done) result.error = loop.reason;
  return result;
}

async function executeActStep(state: RunState, step: Step): Promise<StepResult> {
  const result = newResult(step.id);
  result.status = 'RUNNING';

  // INVARIANT: undo-before-act
  const { card, blocked } = await ensureRollbackCard(state, step);
  if (blocked) {
    const rehearsal = isRehearsed(state.graph);
    const decision = await requestApproval({
      runId: state.runId, step, rollbackCard: card, rehearsalGreen: rehearsal.green,
      willDo: `${step.title} — ⚠️ NO SAFE UNDO COULD BE CONSTRUCTED OR VALIDATED. Executing means accepting irreversible risk.`,
      timeoutMin: 5,
    });
    if (decision !== 'OVERRIDE') {
      result.status = 'BLOCKED';
      result.error = `Rollback Forge: ${card?.reason ?? 'no validated undo'}. Human decision: ${decision}. The agent refuses to act.`;
      appendAudit('step_blocked_no_undo', { step: step.id, decision }, state.runId);
      return result;
    }
    appendAudit('risk_accepted_override', { step: step.id, by: 'human' }, state.runId);
  }

  // INVARIANT: irreversible steps must pass the gate
  if (step.gate) {
    const rehearsal = isRehearsed(state.graph);
    const decision = await requestApproval({
      runId: state.runId, step, rollbackCard: card, rehearsalGreen: rehearsal.green,
      willDo: `${step.title}${step.commands.length ? ` — commands: ${step.commands[0].slice(0, 120)}` : ''}`,
    });
    result.gateDecision = decision as StepResult['gateDecision'];
    if (decision !== 'APPROVED' && decision !== 'OVERRIDE') {
      result.status = 'HALTED';
      result.error = `Gate decision: ${decision}. The agent stopped and asked, as designed.`;
      appendAudit('gate_halt', { step: step.id, decision }, state.runId);
      return result;
    }
  }

  // INVARIANT: rehearsal prerequisite (prod only)
  if (state.target === 'prod') {
    const rehearsal = isRehearsed(state.graph);
    if (!rehearsal.green) {
      result.status = 'BLOCKED';
      result.error = `INVARIANT VIOLATION PREVENTED: this graph has no green rehearsal (${rehearsal.detail}). Run 'rehearse' first.`;
      appendAudit('blocked_no_rehearsal', { step: step.id }, state.runId);
      return result;
    }
  }

  // The agentic execution: Surgeon decides tool calls; runtime executes.
  const surgeon = makeSurgeon({ runId: state.runId, appUrl: targetApp(state, step), dbUrl: targetDb(state, step) });
  const started = Date.now();
  const loop = await runAgentLoop({
    system: `You are SURGEON, the execution subagent of a runbook runtime. You have scoped write access FOR THIS RUN ONLY.
Rules:
- Perform exactly the step's intent — nothing more.
- You are empowered to act because this step is REVERSIBLE (or gated and approved): a validated undo exists: ${card ? JSON.stringify(card.undo).slice(0, 200) : 'gated-approved'}.
- If anything looks different from what the runbook expected, STOP and end with the word HALT and explain.
- When the step is complete, end your final message with the word DONE.`,
    goal: `Step "${step.title}" (${step.type}):\n${step.intent}\n\nCommands suggested by the runbook author (verify before trusting): ${JSON.stringify(step.commands)}`,
    ctx: surgeon,
    transcript: result.transcript,
    onToolCall: (name, args) => console.log(`      🔧 SURGEON → ${name} ${JSON.stringify(args).slice(0, 90)}`),
  });
  result.durationMs = Date.now() - started;

  // Deviation circuit breaker: Surgeon said HALT
  if (/HALT/i.test(loop.reason) && !/DONE/i.test(loop.reason)) {
    result.status = 'HALTED';
    result.error = `Surgeon halted: ${loop.reason}`;
    appendAudit('surgeon_halt', { step: step.id, reason: loop.reason.slice(0, 300) }, state.runId);
    return result;
  }
  result.status = loop.done ? 'DONE' : 'HALTED';
  if (!loop.done) result.error = loop.reason;
  return result;
}

async function executeVerifyStep(state: RunState, step: Step): Promise<StepResult> {
  const result = newResult(step.id);
  result.status = 'RUNNING';
  const target = { appUrl: targetApp(state), dbUrl: targetDb(state) };

  // Independent verification: run authored probes (runtime-executed)
  if (step.probes.length) {
    const twinTargets = { appUrl: config.twinAppUrl, dbUrl: config.twinDbUrl };
    let attempts = 0;
    let results = await runProbes(step.probes, target, twinTargets);
    while (results.some(r => !r.ok) && attempts < 1) {
      attempts++;
      console.log(`      ↻ probe retry (${attempts}/1) after failure`);
      await new Promise(r => setTimeout(r, 2000));
      results = await runProbes(step.probes, target, twinTargets);
    }
    result.probeResults = results;
    console.log(renderProbeResults(results));
    if (results.some(r => !r.ok)) {
      // Agentic diagnosis before halting — Verifier investigates read-only.
      const verifier = makeVerifier({ runId: state.runId, appUrl: target.appUrl, dbUrl: target.dbUrl });
      const failed = results.filter(r => !r.ok).map(r => `${r.probe.kind}:${r.probe.target} → ${r.detail}`).join('; ');
      const loop = await runAgentLoop({
        system: `You are VERIFIER, an independent read-only subagent. A post-step probe FAILED and you must diagnose why before the run halts. You observe only; you cannot fix. Cite evidence. End with DIAGNOSIS: <one paragraph>.`,
        goal: `Failed probes: ${failed}\nInvestigate the likely cause now.`,
        ctx: verifier,
        transcript: result.transcript,
        onToolCall: (name, args) => console.log(`      ✅ VERIFIER → ${name} ${JSON.stringify(args).slice(0, 90)}`),
      });
      result.status = 'HALTED';
      result.error = `Probe failure: ${failed}\nVerifier diagnosis: ${loop.reason.slice(0, 500)}`;
      appendAudit('verify_failed', { step: step.id, failed }, state.runId);
      return result;
    }
    result.status = 'DONE';
    return result;
  }

  // No authored probes — let the Verifier agent verify the step's postcondition.
  const verifier = makeVerifier({ runId: state.runId, appUrl: target.appUrl, dbUrl: target.dbUrl });
  const loop = await runAgentLoop({
    system: `You are VERIFIER, an independent read-only subagent. Verify the postcondition of the step that just ran. Do NOT trust any agent's claims — observe the world yourself (probes, HTTP, read-only SQL). If the postcondition holds, end with DONE. Otherwise end with FAILED: <evidence>.`,
    goal: `Verify step "${step.title}":\n${step.intent}`,
    ctx: verifier,
    transcript: result.transcript,
    onToolCall: (name, args) => console.log(`      ✅ VERIFIER → ${name} ${JSON.stringify(args).slice(0, 90)}`),
  });
  result.status = /DONE/i.test(loop.reason) ? 'DONE' : 'HALTED';
  if (result.status !== 'DONE') result.error = `Verifier: ${loop.reason.slice(0, 400)}`;
  return result;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function executeGraph(graph: Graph, mode: 'REHEARSE' | 'EXECUTE'): Promise<RunState> {
  ensureDirs();
  const runId = `${mode.toLowerCase()}-${Date.now()}`;
  const state: RunState = {
    runId, graph, mode,
    target: mode === 'REHEARSE' ? 'twin' : 'prod',
    results: {}, startedAt: new Date().toISOString(),
  };
  saveState(state);
  appendAudit('run_started', { runbook: graph.title, revision: graph.revision, mode }, runId);

  console.log(`\n🩹 FIRSTRESPONDER — ${mode} ${mode === 'REHEARSE' ? '(against TWIN)' : '(LIVE — prod)'}`);
  console.log(`   runbook: ${graph.title} @${graph.revision}`);
  console.log(`   steps:   ${graph.steps.map(s => `${s.id}[${s.type}]`).join(' → ')}\n`);

  const done = new Set<string>();
  for (const step of graph.steps) {
    // resume support
    const prev = loadResumable(runId)?.results[step.id];
    if (prev && ['DONE'].includes(prev.status)) {
      state.results[step.id] = prev;
      done.add(step.id);
      console.log(`⏭  ${step.id} [${step.type}] ${step.title} — already done (resume)`);
      continue;
    }

    console.log(`▶  ${step.id} [${step.type}] ${step.title}`);

    let result: StepResult;
    try {
      if (step.type === 'READ') result = await executeReadStep(state, step);
      else if (step.type === 'ACT_REVERSIBLE' || step.type === 'ACT_IRREVERSIBLE') result = await executeActStep(state, step);
      else if (step.type === 'VERIFY') result = await executeVerifyStep(state, step);
      else result = { stepId: step.id, status: 'BLOCKED', transcript: [], error: 'UNKNOWN step type' };
    } catch (err) {
      result = { stepId: step.id, status: 'HALTED', transcript: [], error: String(err instanceof Error ? err.message : err) };
    }

    state.results[step.id] = result;
    saveState(state);

    const icon = { DONE: '✅', HALTED: '🛑', BLOCKED: '⛔', GATED: '⛔', PENDING: '·', RUNNING: '·', SKIPPED: '⏭' }[result.status];
    console.log(`${icon}  ${step.id} → ${result.status}${result.error ? ` — ${result.error.slice(0, 200)}` : ''}\n`);

    if (result.status !== 'DONE') {
      appendAudit('run_halted', { step: step.id, status: result.status, error: result.error?.slice(0, 300) }, runId);
      console.log(`\n🛑 Run halted at ${step.id}. The agent stopped and asked — as designed.`);
      console.log(`   State saved to .firerun/runs/${runId}/state.json (resume supported).`);
      writeGateSnapshot();
      state.green = false;
      return state;
    }
    done.add(step.id);
  }

  state.green = true;
  saveState(state);
  appendAudit('run_completed', { green: true }, runId);

  if (mode === 'REHEARSE') {
    fs.writeFileSync(REHEARSAL_MARKER(graph), JSON.stringify({ green: true, at: new Date().toISOString(), runId }));
    console.log(`\n✅ Rehearsal GREEN — graph fingerprint unlocked for live execution.`);
  } else {
    console.log(`\n✅ Runbook executed end-to-end. Now invoking the flywheel (addendum writer)...`);
  }
  return state;
}

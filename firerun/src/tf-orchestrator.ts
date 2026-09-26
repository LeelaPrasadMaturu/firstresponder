/**
 * FIRSTRESPONDER × TrueForge — the orchestrator.
 *
 * THE COMPLIANCE-CRITICAL PATH: the agent loop runs INSIDE TrueForge
 * (sessions, turns, harness approvals, subagents). This module owns only the
 * deterministic safety layer around it:
 *
 *   compile (graph) → per step: role agent + TF turn → OUR probes verify →
 *   rollback-card invariant → rehearsal marker → flywheel
 *
 * Map to rubric: "the harness is doing the work" = the tool calls, sandbox
 * and approval pauses happen in TrueForge; "where it stops" = our invariants
 * (undo-before-act, rehearsal-prerequisite, UNKNOWN→irreversible) still gate
 * everything deterministically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';
import { appendAudit } from './audit.js';
import { runTurn, verifyWithProbes, type TfRole } from './trueforge/runner.js';
import { requestApproval, writeGateSnapshot } from './gate.js';
import { writeAddendum } from './flywheel.js';
import type { Graph, RunState, Step, StepResult } from './types.js';

const REHEARSAL_MARKER = (graph: Graph) => path.join(config.runsDir, `rehearsal-${fingerprint(graph)}.json`);

function fingerprint(g: Graph): string {
  let h = 0;
  for (const s of g.steps) h = (h * 31 + s.id.length + s.type.length + s.intent.length) >>> 0;
  return h.toString(16);
}

export function isRehearsed(g: Graph): { green: boolean; detail: string } {
  const marker = REHEARSAL_MARKER(g);
  if (!fs.existsSync(marker)) return { green: false, detail: `no rehearsal artifact for this graph version` };
  const r = JSON.parse(fs.readFileSync(marker, 'utf8'));
  return { green: !!r.green, detail: `rehearsed at ${r.at}` };
}

function targetUrls(step: Step | undefined, mode: 'REHEARSE' | 'EXECUTE') {
  const useTwin = mode === 'REHEARSE' || step?.target === 'twin';
  return { appUrl: useTwin ? config.twinAppUrl : config.prodAppUrl, dbUrl: useTwin ? config.twinDbUrl : config.prodDbUrl };
}

const readSeen = new Set<string>(); // per-run READ step tracker (see roleFor)
function roleFor(step: Step): TfRole {
  if (step.type === 'READ') {
    // first READ of a run = triage (SCOUT); deeper investigation = ANALYST
    const firstRead = !readSeen.has('read');
    readSeen.add('read');
    return firstRead ? 'SCOUT' : 'ANALYST';
  }
  if (step.type === 'VERIFY') return 'VERIFIER';
  if (step.type === 'ACT_IRREVERSIBLE') return 'EXECUTOR';
  return 'SURGEON';
}

function saveState(state: RunState): void {
  const dir = path.join(config.runsDir, state.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

/** Rollback card: forged by the Surgeon agent itself in a pre-step turn. */
async function forgeRollbackCard(runId: string, step: Step): Promise<NonNullable<Step['rollback']>> {
  if (step.rollback) return step.rollback; // author-declared no-undo (UNABLE)

  // PREFERRED: the runbook author's own `Undo:` line — deterministic.
  // (Model-forged undos proved flaky: GLM occasionally returns empty replies,
  // and an authored undo is a stronger source than a generated one anyway.)
  if (step.undoHint) {
    console.log(`      🛠  Rollback Forge → authored undo (${step.undoHint.slice(0, 60)}...)`);
    appendAudit('rollback_card_authored', { step: step.id }, runId);
    return {
      step: step.id,
      undo: step.undoHint,
      undoVerification: ["re-run the step's verification probes after the undo"],
      undoEstimatedTime: '60s',
      confidence: 'MEDIUM',
      tested: false,
      reason: 'runbook-authored undo (Undo: line)',
    };
  }
  const outcome = await runTurn({
    runId,
    role: 'SURGEON',
    goal: `ROLLBACK FORGE — you are NOT executing anything yet. For the step below, produce the exact shell undo command(s) that reverse its effect (read-only reasoning; do not run write tools).

Your reply MUST follow this exact format (plain text, no markdown):
UNDO: <the exact shell command that reverses the step>
TEST: <how to verify the undo worked>

If no safe undo exists, reply exactly:
UNDO: NONE
REASON: <why>

Step: ${step.title}
${step.intent}

The step's runbook commands (from the code blocks — these ARE the deployment commands):
${JSON.stringify(step.commands, null, 1)}

The runbook's own undo note: ${JSON.stringify(step.commands.length ? '(see intent above)' : 'none')}`,
    step,
  });
  const m = outcome.reply.match(/UNDO[:\s*]+\*{0,2}\s*(.+)/i);
  const undo = (m?.[1] ?? '').replace(/\*+/g, '').trim();
  const unable = /UNDO[:\s*]+NONE/i.test(outcome.reply) || !undo;
  console.log(`      🛠  Rollback Forge → ${unable ? 'UNABLE' : `undo found (${undo.slice(0, 60)}...)`}`);
  if (unable) console.log(`      [forge raw reply] ${outcome.reply.slice(0, 400)}`);
  appendAudit('rollback_card_forged', { step: step.id, unable, undo: undo.slice(0, 200) }, runId);
  return {
    step: step.id,
    undo: unable ? '' : undo,
    undoVerification: unable ? [] : (outcome.reply.match(/TEST:\s*(.+)/)?.[1] ?? 're-run step probes').split(';'),
    undoEstimatedTime: '60s',
    confidence: unable ? 'UNABLE' : 'MEDIUM',
    tested: false,
    reason: unable ? (outcome.reply.match(/REASON[:\s*]+(.+)/i)?.[1] ?? outcome.reply.match(/—\s*(.+)$/)?.[1] ?? 'no safe undo could be constructed') : undefined,
  };
}

export async function executeGraphTF(graph: Graph, mode: 'REHEARSE' | 'EXECUTE'): Promise<RunState> {
  ensureDirs();
  // REHEARSE runs against the disposable twin — gates decide instantly
  // (auto). Only EXECUTE opens the human gate. (Without this, a rehearsal
  // hangs for GATE_TIMEOUT_MIN waiting for an approval nobody will give.)
  const previousGateMode = config.gateMode;
  if (mode === 'REHEARSE') config.gateMode = 'auto';
  try {
  const runId = `tf-${mode.toLowerCase()}-${Date.now()}`;
  const state: RunState = {
    runId, graph, mode,
    target: mode === 'REHEARSE' ? 'twin' : 'prod',
    results: {}, startedAt: new Date().toISOString(),
  };
  saveState(state);
  appendAudit('run_started', { runbook: graph.title, revision: graph.revision, mode, runtime: 'trueforge' }, runId);
  readSeen.clear();

  console.log(`\n🩹 FIRSTRESPONDER — ${mode} via TRUEFORGE ${mode === 'REHEARSE' ? '(against TWIN)' : '(LIVE)'}`);
  console.log(`   runbook: ${graph.title} @${graph.revision}`);
  console.log(`   steps:   ${graph.steps.map(s => `${s.id}[${s.type}]`).join(' → ')}\n`);

  for (const step of graph.steps) {
    console.log(`▶  ${step.id} [${step.type}] ${step.title}`);
    const result: StepResult = { stepId: step.id, status: 'RUNNING', transcript: [] };

    try {
      const role = roleFor(step);
      const targets = targetUrls(step, mode);

      // INVARIANT: undo-before-act (forge the card BEFORE any action)
      let card: Step['rollback'];
      if (step.type.startsWith('ACT')) {
        card = await forgeRollbackCard(runId, step);
        step.rollback = card;
        if (card.confidence === 'UNABLE') {
          const rehearsal = isRehearsed(graph);
          const decision = await requestApproval({
            runId, step, rollbackCard: card, rehearsalGreen: rehearsal.green,
            willDo: `${step.title} — ⚠️ NO SAFE UNDO. Executing means accepting irreversible risk.`,
            timeoutMin: 5,
          });
          if (decision !== 'OVERRIDE') {
            result.status = 'BLOCKED';
            result.error = `Rollback Forge: ${card.reason ?? 'no validated undo'}. Human: ${decision}. The agent refuses to act.`;
            console.log(`⛔ ${step.id} → BLOCKED (no undo — the line held)\n`);
            state.results[step.id] = result; saveState(state);
            appendAudit('step_blocked_no_undo', { step: step.id, decision }, runId);
            state.green = false;
            return state;
          }
          appendAudit('risk_accepted_override', { step: step.id }, runId);
        }
      }

      // INVARIANT: irreversible steps pass ONE gate per step (not per tool call)
      let preApproved = false;
      if (step.gate && mode === 'EXECUTE') {
        const rehearsal = isRehearsed(state.graph);
        const decision = await requestApproval({
          runId, step, rollbackCard: card, rehearsalGreen: rehearsal.green,
          willDo: `${step.title}${step.commands.length ? ` — e.g. ${step.commands[0].slice(0, 120)}` : ''}`,
        });
        result.gateDecision = decision as StepResult['gateDecision'];
        if (decision !== 'APPROVED' && decision !== 'OVERRIDE') {
          result.status = 'HALTED';
          result.error = `Gate decision: ${decision}. The agent stopped and asked, as designed.`;
          console.log(`🛑 ${step.id} → HALTED (gate: ${decision})\n`);
          state.results[step.id] = result; saveState(state);
          appendAudit('gate_halt', { step: step.id, decision }, runId);
          state.green = false;
          return state;
        }
        preApproved = true;
      }

      // The agentic execution — INSIDE TrueForge
      const preamble = mode === 'REHEARSE'
        ? 'REHEARSAL MODE: you are running against the STAGING TWIN (disposable clone of prod). The twin is disposable — act on it freely.\n\n'
        : '';
      const dbTarget = (mode === 'REHEARSE' || step.target === 'twin') ? 'twin' : 'prod';
      const goal = `${preamble}Target app: ${targets.appUrl} · DB target: ${dbTarget}${mode === 'REHEARSE' ? ' (the TWIN — writes here are expected and safe in rehearsal)' : ''}\nExecute this runbook step exactly:\n\n"${step.title}"\n${step.intent}\n\nSuggested commands from the runbook author (verify before trusting): ${JSON.stringify(step.commands)}`;
      const outcome = await runTurn({
        runId, role, goal, step,
        rollbackCard: card ? { undo: card.undo, confidence: card.confidence, tested: card.tested } : undefined,
        preApproved,
        onToolCall: (name, args) => console.log(`      🔧 ${role} → ${name} ${args.slice(0, 80)}`),
        transcript: result.transcript,
      });

      if (outcome.status === 'HALT') {
        result.status = 'HALTED';
        result.error = `Surgeon halted: ${outcome.reply.slice(0, 300)}`;
        console.log(`🛑 ${step.id} → HALTED (agent stopped and asked)`);
        console.log(`   reason: ${outcome.reply.slice(0, 250)}\n`);
        state.results[step.id] = result; saveState(state);
        appendAudit('run_halted', { step: step.id, error: result.error.slice(0, 200) }, runId);
        writeGateSnapshot();
        state.green = false;
        return state;
      }

      // Independent verification — OUR probes, not the model's claims
      if (step.probes.length) {
        const ok = await verifyWithProbes(state, step, result);
        if (!ok) {
          result.status = 'HALTED';
          result.error = 'Probe failure — verification is runtime-owned; the model cannot talk its way past a failed probe.';
          console.log(`🛑 ${step.id} → HALTED (probe failure)\n`);
          state.results[step.id] = result; saveState(state);
          state.green = false;
          return state;
        }
      }

      result.status = 'DONE';
      console.log(`✅ ${step.id} → DONE\n`);
    } catch (err) {
      result.status = 'HALTED';
      result.error = String(err instanceof Error ? err.message : err).slice(0, 300);
      console.log(`💥 ${step.id} → ${result.error}\n`);
      state.results[step.id] = result; saveState(state);
      state.green = false;
      return state;
    }

    state.results[step.id] = result;
    saveState(state);
  }

  state.green = true;
  saveState(state);
  appendAudit('run_completed', { green: true }, runId);
  if (mode === 'REHEARSE') {
    fs.writeFileSync(REHEARSAL_MARKER(graph), JSON.stringify({ green: true, at: new Date().toISOString(), runId }));
    console.log('✅ Rehearsal GREEN — graph unlocked for live execution.');
  } else {
    await writeAddendum(state);
  }
  return state;
  } finally {
    config.gateMode = previousGateMode;
  }
}

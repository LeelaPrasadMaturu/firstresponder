/**
 * FIRSTRESPONDER × TrueForge — the step runner.
 *
 * ONE runbook step = ONE TrueForge turn. The harness runs the agent loop;
 * we own the deterministic safety layer around it:
 *
 *   - compile runbook → graph (unchanged, deterministic)
 *   - per step: pick the role agent (Scout/Surgeon/Verifier), open a session,
 *     stream the turn, collect tool.approval_required events, bridge them to
 *     our blast-radius/rollback-card gate, resume with user.tool_approval
 *   - after the turn: run OUR probes (Verifier data comes from the runtime,
 *     not from the model's claims)
 *
 * Sessions persist per (run, role) — reconnects resume via session id.
 */
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { config, ensureDirs } from '../config.js';
import { appendAudit } from '../audit.js';
import { requestApproval } from '../gate.js';
import { runProbes, renderProbeResults } from '../probes.js';
import type { RunState, Step, StepResult } from '../types.js';

export type TfRole = 'SCOUT' | 'ANALYST' | 'SURGEON' | 'EXECUTOR' | 'VERIFIER' | 'SCRIBE';

let client: TrueForge | null = null;
function tf(): TrueForge {
  if (!client) {
    client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790', timeoutInSeconds: 600 });
  }
  return client;
}

const sessionCache = new Map<string, string>(); // `${runId}:${role}` → sessionId

async function getSession(runId: string, role: TfRole): Promise<string> {
  const key = `${runId}:${role}`;
  const existing = sessionCache.get(key);
  if (existing) return existing;
  const { data } = await tf().sessions.create({
    agent: { name: `firerun-${role.toLowerCase()}` },
  } as never);
  const id = (data as { id: string }).id;
  sessionCache.set(key, id);
  appendAudit('tf_session_created', { role, sessionId: id }, runId);
  return id;
}

export interface TfTurnOutcome {
  status: 'DONE' | 'HALT' | 'FAILED';
  reply: string;
  toolCalls: Array<{ name: string; args: string; approved?: boolean }>;
  transcript: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
}

/**
 * Stream one turn; on tool.approval_required, bridge to OUR gate (blast
 * radius + rollback card from the step), then resume with user.tool_approval.
 */
export async function runTurn(opts: {
  runId: string;
  role: TfRole;
  goal: string;
  step?: Step;
  rollbackCard?: { undo: string; confidence: string; tested?: boolean };
  /** the STEP's gate was already approved — allow gated tool calls without re-gating */
  preApproved?: boolean;
  onToolCall?: (name: string, args: string) => void;
  transcript?: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
}): Promise<TfTurnOutcome> {
  ensureDirs();
  const sessionId = await getSession(opts.runId, opts.role);
  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
  const toolCalls: TfTurnOutcome['toolCalls'] = [];
  const transcript = opts.transcript ?? [];
  const deltas: string[] = [];

  const stream = await tf().sessions.createTurnStream(sessionId, {
    input: [{ type: 'user.message', content: opts.goal }],
  } as never);

  let sawDelta = false;
  for await (const { data: event } of (stream as { withMetadata: () => AsyncIterable<{ data: TrueForgeApi.TurnStreamingEvent }> }).withMetadata()) {
    if (isEventDelta(event)) {
      // Deltas carry partial chunks — merge them into the id-keyed event so
      // the final model.message holds the COMPLETE text. (Capturing only the
      // first chunk truncated replies mid-sentence and broke the Rollback Forge.)
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event); else events.set(event.id, event);
      sawDelta = true;
      continue;
    }
    events.set(event.id, event);

    if (event.type === 'thread.created') {
      console.log(`      ↳ subagent: ${(event as { title?: string }).title}`);
    }
    if (event.type === 'tool.response') {
      const e = event as { threadId?: string; name?: string };
      console.log(`      🔧 ${opts.role} tool → ${e.name ?? 'tool'}`);
    }
    if (event.type === 'tool.approval_required') {
      pendingApprovals.push(event as TrueForgeApi.ToolApprovalRequiredEvent);
    }
    if (event.type === 'turn.done') {
      const state = (event as { state?: { status?: string; output?: { content?: string } } }).state;
      // Prefer the merged final model.message (complete text); fall back to
      // turn output, then raw deltas.
      let reply = '';
      for (const ev of events.values()) {
        if (ev.type === 'model.message') {
          const c = (ev as { threadId?: string; content?: string });
          if (!c.threadId || c.threadId === 'main') reply = c.content ?? reply;
        }
      }
      reply = reply || state?.output?.content || deltas.join('');
      transcript.push({ role: 'assistant', content: reply });
      break;
    }
  }

  // Bridge approvals through OUR gate (blast radius + rollback card + audit)
  const approvals: TrueForgeApi.UserToolApprovalEvent[] = [];
  for (const pending of pendingApprovals) {
    for (const ref of pending.toolCalls) {
      const msg = events.get(ref.sourceEventId);
      if (msg?.type !== 'model.message') continue;
      const call = (msg as { toolCalls?: Array<{ id: string; function?: { name: string; arguments: string } }> }).toolCalls?.find(tc => tc.id === ref.id);
      if (!call?.function) continue;
      opts.onToolCall?.(call.function.name, call.function.arguments);
      toolCalls.push({ name: call.function.name, args: call.function.arguments });

      let decision: 'allow' | 'deny' = 'deny';
      let reason = 'denied by human';
      if (opts.preApproved) {
        decision = 'allow';
        reason = 'allowed — step gate pre-approved by human';
      } else if (opts.step?.gate || GATED_TOOL_NAMES.includes(call.function.name)) {
        const d = await requestApproval({
          runId: opts.runId,
          step: opts.step ?? { id: `tool-${call.function.name}`, title: call.function.name, type: 'ACT_IRREVERSIBLE', classifiedBy: 'marker', intent: call.function.arguments, commands: [], probes: [], gate: true, requires: [], sourceLine: 0 },
          rollbackCard: opts.rollbackCard ? { step: opts.step?.id ?? '', undo: opts.rollbackCard.undo, undoVerification: [], undoEstimatedTime: 'n/a', confidence: opts.rollbackCard.confidence as 'HIGH' | 'MEDIUM' | 'UNABLE', tested: opts.rollbackCard.tested } : undefined,
          willDo: `${call.function.name}(${call.function.arguments.slice(0, 160)})`,
        });
        decision = d === 'APPROVED' || d === 'OVERRIDE' ? 'allow' : 'deny';
        reason = d === 'REJECTED' ? 'rejected by human at the gate' : d === 'TIMEOUT' ? 'gate timed out' : reason;
      } else {
        // Tool is not in the gated set but the harness asked — allow by policy
        decision = 'allow';
        reason = 'allowed (non-gated tool)';
      }
      toolCalls[toolCalls.length - 1].approved = decision === 'allow';
      approvals.push({
        type: 'user.tool_approval',
        threadId: pending.threadId,
        toolCallId: ref.id,
        approval: { status: decision, ...(decision === 'deny' ? { reason } : {}) },
      } as TrueForgeApi.UserToolApprovalEvent);
    }
  }

  if (approvals.length) {
    // Resume the SAME turn with the approval decisions — the harness continues.
    const resume = await tf().sessions.createTurnStream(sessionId, { input: approvals } as never);
    for await (const { data: event } of (resume as { withMetadata: () => AsyncIterable<{ data: TrueForgeApi.TurnStreamingEvent }> }).withMetadata()) {
      if (isEventDelta(event)) {
        const base = events.get(event.id);
        if (base) mergeEventDelta(base, event); else events.set(event.id, event);
        continue;
      }
      if (event.type === 'tool.response') console.log(`      🔧 ${opts.role} tool → resumed`);
      if (event.type === 'turn.done') {
        const st = (event as { state?: { status?: string; output?: { content?: string } } }).state;
        let reply = '';
        for (const ev of events.values()) {
          if (ev.type === 'model.message') {
            const c = (ev as { threadId?: string; content?: string });
            if (!c.threadId || c.threadId === 'main') reply = c.content ?? reply;
          }
        }
        transcript.push({ role: 'assistant', content: reply || st?.output?.content || deltas.join('') });
      }
    }
  }

  const reply = transcript.filter(t => t.role === 'assistant').at(-1)?.content || deltas.join('') || '';
  const status: TfTurnOutcome['status'] = /HALT/i.test(reply) ? 'HALT' : /FAILED/i.test(reply) && /VERIFIER/i.test(reply) ? 'HALT' : /DONE|CONCLUSION/i.test(reply) ? 'DONE' : 'DONE';
  appendAudit('tf_turn_done', { role: opts.role, status, toolCalls: toolCalls.length }, opts.runId);
  return { status, reply, toolCalls, transcript };
}

const GATED_TOOL_NAMES = ['stage_db_write', 'stage_exec'];

/** Post-turn verification with OUR probes — independent of model claims. */
export async function verifyWithProbes(state: RunState, step: Step, result: StepResult): Promise<boolean> {
  if (!step.probes.length) return true;
  const twinTargets = { appUrl: config.twinAppUrl, dbUrl: config.twinDbUrl };
  const prodTargets = { appUrl: config.prodAppUrl, dbUrl: config.prodDbUrl };
  const primary = state.target === 'twin' ? twinTargets : prodTargets;
  const results = await runProbes(step.probes, primary, twinTargets);
  result.probeResults = results;
  console.log(renderProbeResults(results));
  return results.every(r => r.ok);
}

import { askStructured } from './agent.js';
import { makeSurgeon } from './tools.js';
import { appendAudit } from './audit.js';
import type { RollbackCard, Step } from './types.js';

/**
 * ROLLBACK FORGE — "No undo, no action."
 *
 * For every ACT_* step, the agent must produce a rollback card BEFORE execution.
 * The card is schema-validated, and during rehearsal the undo command is
 * ACTUALLY EXECUTED against the staging twin. An undo that was never run
 * against the twin is capped at MEDIUM confidence; UNABLE blocks the step.
 *
 * The orchestrator (not the model) enforces: no validated card ⇒ no execution.
 */

const CARD_SCHEMA = `{
  "step": "<step id>",
  "undo": "<exact shell command(s) that reverse this step>",
  "undoVerification": ["<how to prove the undo worked>", "..."],
  "undoEstimatedTime": "<e.g. 90s>",
  "confidence": "HIGH" | "MEDIUM" | "UNABLE",
  "reason": "<required if UNABLE: why no safe undo exists>"
}`;

function validateCard(obj: unknown, step: Step): RollbackCard | null {
  const c = obj as RollbackCard;
  if (!c || typeof c !== 'object') return null;
  if (c.confidence === 'UNABLE') {
    return { ...c, step: step.id, undo: '', undoVerification: [], undoEstimatedTime: 'n/a', reason: c.reason ?? 'agent could not construct a safe undo' };
  }
  if (typeof c.undo !== 'string' || c.undo.trim().length < 3) return null;
  if (!Array.isArray(c.undoVerification) || c.undoVerification.length === 0) return null;
  if (!['HIGH', 'MEDIUM'].includes(c.confidence)) return null;
  return { ...c, step: step.id, undoVerification: c.undoVerification.map(String) };
}

export async function forgeRollbackCard(step: Step, ctx: { runId: string; appUrl: string; dbUrl: string }): Promise<RollbackCard> {
  const surgeonCtx = makeSurgeon(ctx); // forge may inspect the world to build the undo
  const card = await askStructured<RollbackCard>({
    system: `You are the Rollback Forge, part of a runbook-execution runtime with a hard invariant: NO UNDO, NO ACTION.
Your job: for the given step, produce the exact commands that reverse its effect.
Rules:
- The undo must be runnable in a shell. Use the tools to inspect current state so the undo is precise (IDs, versions, snapshot names).
- If the step's effect CANNOT be safely reversed (irreversible data loss, external side effects), set confidence to UNABLE and explain. UNABLE is a first-class, respected answer — the runtime will BLOCK the step.
- Never invent snapshot names or versions you did not observe.`,
    user: `Step: ${step.id} — ${step.title}
Intent: ${step.intent}
Commands from the runbook: ${JSON.stringify(step.commands)}
Blast radius noted by the runbook author: ${step.blastRadius ?? '(not specified — inspect and compute)'}`,
    schemaHint: CARD_SCHEMA,
    validate: obj => validateCard(obj, step),
    ctx: surgeonCtx,
  });

  appendAudit('rollback_card_forged', { step: step.id, confidence: card.confidence, undo: card.undo?.slice(0, 200) }, ctx.runId);
  return card;
}

/**
 * Rehearsal validation: actually run the undo against the TWIN.
 * A card that was never tested cannot be HIGH confidence.
 */
export async function validateRollbackAgainstTwin(
  card: RollbackCard,
  ctx: { runId: string; twinAppUrl: string; twinDbUrl: string },
): Promise<{ tested: boolean; detail: string }> {
  if (card.confidence === 'UNABLE') return { tested: false, detail: 'no undo to test' };
  if (!card.undo.trim()) return { tested: false, detail: 'empty undo command' };
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('bash', ['-c', card.undo], {
      cwd: '.firerun/sandbox',
      timeout: 20_000,
      encoding: 'utf8',
      maxBuffer: 1024 * 256,
      env: {
        ...process.env,
        TWIN_APP_URL: ctx.twinAppUrl,
        TWIN_DB_URL: ctx.twinDbUrl,
      },
    });
    appendAudit('rollback_card_tested', { step: card.step, ok: true }, ctx.runId);
    return { tested: true, detail: out.slice(0, 500) || 'exit 0' };
  } catch (err) {
    const e = err as { stderr?: string };
    appendAudit('rollback_card_test_failed', { step: card.step, err: e.stderr?.slice(0, 300) }, ctx.runId);
    return { tested: false, detail: e.stderr?.slice(0, 300) ?? 'undo failed against twin' };
  }
}

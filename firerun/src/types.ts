// ─── Types: the Execution Graph ──────────────────────────────────────────────
// The graph is produced deterministically by the compiler. The LLM never edits
// it directly — it only fills classified fields through validated outputs.

export type StepType =
  | 'READ'
  | 'ACT_REVERSIBLE'
  | 'ACT_IRREVERSIBLE'
  | 'VERIFY'
  | 'UNKNOWN';

export interface Probe {
  kind: 'http' | 'db' | 'content' | 'command';
  /** http: url | db: sql | content: url | command: shell */
  target: string;
  /** probe the staging twin regardless of run target (append '@twin' in the marker) */
  twin?: boolean;
  expectStatus?: number;
  /** substring that must appear in body/output */
  expectContains?: string;
  /** db: expected row count (exact or '>n' / '<n') */
  expectRows?: string;
  description?: string;
}

export interface RollbackCard {
  step: string;
  undo: string;                 // shell command(s) that reverse the step
  undoVerification: string[];   // probes proving the undo worked
  undoEstimatedTime: string;
  confidence: 'HIGH' | 'MEDIUM' | 'UNABLE';
  tested?: boolean;             // validated against the twin during rehearsal
  reason?: string;              // when UNABLE
}

export interface Step {
  id: string;                   // step-1, step-2, ...
  title: string;
  type: StepType;
  /** how the type was decided */
  classifiedBy: 'marker' | 'agent' | 'fail-safe';
  /** runbook-authored undo (the `Undo:` lines) — deterministic, preferred over model-forged */
  undoHint?: string;
  /** natural-language intent given to the agent */
  intent: string;
  /** shell commands extracted from the runbook (hints, not mandates) */
  commands: string[];
  probes: Probe[];
  rollback?: RollbackCard;
  blastRadius?: string;
  gate: boolean;
  /** 'twin' = always execute against the staging twin, even in prod runs */
  target?: 'twin' | 'prod';
  requires: string[];
  /** max deviation tolerance vs rehearsal, e.g. 0.02 = 2% */
  tolerance?: number;
  sourceLine: number;
}

export interface Graph {
  runbook: string;
  title: string;
  revision: string;             // git sha or 'uncommitted'
  steps: Step[];
  compiledAt: string;
}

export type StepStatus =
  | 'PENDING' | 'RUNNING' | 'DONE' | 'HALTED' | 'BLOCKED' | 'GATED' | 'SKIPPED';

export interface StepResult {
  stepId: string;
  status: StepStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** transcript of the agentic loop for this step */
  transcript: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
  probeResults?: Array<{ probe: Probe; ok: boolean; detail: string }>;
  gateDecision?: 'APPROVED' | 'REJECTED' | 'TIMEOUT' | 'OVERRIDE';
  error?: string;
}

export interface RunState {
  runId: string;
  graph: Graph;
  mode: 'REHEARSE' | 'EXECUTE';
  target: 'twin' | 'prod';
  results: Record<string, StepResult>;
  startedAt: string;
  green?: boolean;
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export interface AuditRecord {
  seq: number;
  ts: string;
  runId?: string;
  event: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

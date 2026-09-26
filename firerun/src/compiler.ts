import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyStepWithAgent } from './agent.js';
import type { Graph, Probe, Step, StepType } from './types.js';

/**
 * COMPILER — deterministic markdown → Execution Graph.
 *
 * Convention layer (invisible to a human reader, load-bearing for the runtime):
 *   <!-- firerun: type=ACT_IRREVERSIBLE | rollback-undo="..." | blast-radius="..." -->
 *   <!-- firerun-probe: http http://app/healthz expectStatus=200 -->
 *   <!-- firerun-probe: db "SELECT count(*) FROM cache_shards" expectRows=">0" -->
 *
 * Rules:
 *  - A step with no marker → the agent classifies it; low confidence ⇒ UNKNOWN.
 *  - UNKNOWN is ALWAYS treated as ACT_IRREVERSIBLE (fail-safe). Enforced here,
 *    in code — the model cannot soften it.
 */

const STEP_RE = /^#{2,3}\s+(?:Step\s+\d+\s*[—–-]\s*)?(.+)$/gm;

function parseProbe(line: string): Probe | null {
  // format: firerun-probe: <kind> <target> [key=value ...]
  const m = line.trim().match(/^(\w+)\s+(.+)$/);
  if (!m) return null;
  const [, kind, rest] = m;
  const parts = rest.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const target = (parts[0] ?? '').replace(/^"|"$/g, '');
  const probe: Probe = { kind: kind as Probe['kind'], target };
  if (target.endsWith('@twin')) {
    probe.twin = true;
    probe.target = target.slice(0, -5);
  }
  for (const p of parts.slice(1)) {
    const kv = p.match(/(\w+)=(\S+)/);
    if (!kv) continue;
    if (kv[1] === 'expectStatus') probe.expectStatus = Number(kv[2]);
    if (kv[1] === 'expectContains') probe.expectContains = kv[2].replace(/^"|"$/g, '');
    if (kv[1] === 'expectRows') probe.expectRows = kv[2];
  }
  return probe;
}

function extractBash(md: string): string[] {
  const out: string[] = [];
  const re = /```(?:bash|sh|shell|sql)?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const cmd = m[1].trim();
    if (cmd) out.push(cmd);
  }
  return out;
}

export async function compileRunbook(mdPath: string, opts: { useAgent?: boolean } = {}): Promise<Graph> {
  const md = fs.readFileSync(mdPath, 'utf8');
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1] ?? mdPath.split('/').pop() ?? 'runbook';

  // find headings + their line offsets — STOP at the flywheel addendum marker:
  // appended addenda are run history, not executable steps.
  const addendumIdx = md.indexOf('## 🩹');
  const parseable = addendumIdx >= 0 ? md.slice(0, addendumIdx) : md;
  const headings: Array<{ line: number; title: string }> = [];
  let hm: RegExpExecArray | null;
  const re = new RegExp(STEP_RE.source, 'gm');
  while ((hm = re.exec(parseable))) {
    if (/^#\s/.test(hm[0])) continue; // skip H1 title
    headings.push({ line: hm.index, title: hm[1].trim() });
  }

  const steps: Step[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].line;
    const end = i + 1 < headings.length ? headings[i + 1].line : md.length;
    const body = md.slice(start, end);
    const firstLineEnd = body.indexOf('\n');
    const stepTitle = body.slice(0, firstLineEnd).replace(/^#{2,3}\s+(?:Step\s+\d+\s*[—–-]\s*)?/, '').trim();

    // convention markers
    const marker = body.match(/<!--\s*firerun:\s*([\s\S]*?)-->/);
    const probeLines = [...body.matchAll(/<!--\s*firerun-probe:\s*([\s\S]*?)-->/g)].map(m => m[1]);

    const probes: Probe[] = [];
    for (const pl of probeLines) {
      const p = parseProbe(pl);
      if (p) probes.push(p);
    }

    const kv: Record<string, string> = {};
    if (marker) {
      for (const pair of marker[1].split('|')) {
        const kv2 = pair.trim().match(/^([\w-]+)\s*=\s*(.*)$/);
        if (kv2) kv[kv2[1]] = kv2[2].trim().replace(/^"|"$/g, '');
      }
    }

    let type: StepType = 'UNKNOWN';
    let classifiedBy: Step['classifiedBy'] = 'fail-safe';
    if (kv.type && ['READ', 'ACT_REVERSIBLE', 'ACT_IRREVERSIBLE', 'VERIFY'].includes(kv.type)) {
      type = kv.type as StepType;
      classifiedBy = 'marker';
    } else if (opts.useAgent !== false) {
      // agentic classification — model proposes, runtime validates
      type = await classifyStepWithAgent(stepTitle, body);
      classifiedBy = 'agent';
    }

    // THE FAIL-SAFE, in code, not in a prompt:
    if (type === 'UNKNOWN') type = 'ACT_IRREVERSIBLE';

    const gate = type === 'ACT_IRREVERSIBLE';

    // Author-declared no-undo: the author KNOWS no reversal exists (e.g. no
    // backup). The runtime honors the declaration: rollback card is UNABLE,
    // and the orchestrator will BLOCK unless a human explicitly overrides.
    // Runbook-authored undo: the strongest source. The authors of good
    // runbooks already write "Undo: <command>" — use it deterministically
    // instead of asking a model to reconstruct it (no flakiness, no latency).
    const undoLines = [...body.matchAll(/^\s*Undo:\s*(.+)$/gm)].map(m2 => m2[1].replace(/`/g, '').trim());
    const undoHint = undoLines.length ? undoLines.join(' && ') : undefined;

    let rollback: Step['rollback'];
    if (kv['no-undo'] === 'true') {
      rollback = {
        step: `step-${steps.length + 1}`,
        undo: '',
        undoVerification: [],
        undoEstimatedTime: 'n/a',
        confidence: 'UNABLE',
        tested: false,
        reason: 'runbook author declares no safe undo exists (no-undo=true)',
      };
    }

    steps.push({
      id: `step-${steps.length + 1}`,
      title: stepTitle,
      type,
      classifiedBy,
      intent: body
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/```[\s\S]*?```/g, '(code block — see commands)')
        .replace(/#{2,3}\s*/, '')
        .replace(/\n{2,}/g, '\n')
        .trim(),
      commands: extractBash(body),
      probes,
      blastRadius: kv['blast-radius'],
      undoHint,
      target: (kv.target as Step['target']) ?? undefined,
      rollback,
      requires: i > 0 ? [`step-${steps.length}`] : [],
      gate,
      sourceLine: md.slice(0, start).split('\n').length,
    });
  }

  let revision = 'uncommitted';
  try {
    const { execFileSync } = await import('node:child_process');
    revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.dirname(mdPath), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || revision;
  } catch { /* not a git repo — fine */ }

  return { runbook: mdPath, title, revision, steps, compiledAt: new Date().toISOString() };
}

/** The fail-safe id used in demo narration. */
export function gateSteps(graph: Graph): Step[] {
  return graph.steps.filter(s => s.gate);
}

export function graphFingerprint(g: Graph): string {
  return crypto.createHash('sha256').update(JSON.stringify(g.steps.map(s => [s.id, s.type, s.intent]))).digest('hex').slice(0, 12);
}

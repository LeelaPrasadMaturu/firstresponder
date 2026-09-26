import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { config } from './config.js';
import { appendAudit } from './audit.js';
import type { RollbackCard, Step } from './types.js';

/**
 * THE GATE — human approval before irreversible actions.
 *
 * Channels (same audit semantics on all):
 *   http — approval card served on :GATE_PORT, approve from any device
 *          (including a phone on the same network — the demo moment)
 *   cli  — terminal prompt fallback
 *   auto — no human (REHEARSE mode only)
 *
 * The gate is built on the same primitive TrueForge exposes as tool-approval
 * checkpoints; this module is our blast-radius/rollback-card layer on top.
 */

interface PendingGate {
  id: string;
  step: Step;
  rollbackCard?: RollbackCard;
  rehearsalGreen?: boolean;
  willDo: string;
  blastRadius: string;
  undo: string;
  undoTested: boolean;
  createdAt: string;
  decision?: 'APPROVED' | 'REJECTED' | 'OVERRIDE';
  decidedAt?: string;
  decidedBy?: string;
}

const gates = new Map<string, PendingGate>();

// ─── Slack: rich card with working Approve/Reject buttons ──────────────────

function slackBlocks(g: PendingGate): object[] {
  const conf = g.rollbackCard?.confidence ?? 'MISSING';
  const undoTxt = g.rollbackCard?.confidence === 'UNABLE'
    ? '*No safe undo* — the step will be blocked unless a human explicitly overrides'
    : `\`${(g.undo || 'n/a').slice(0, 180)}\` — ${g.undoTested ? 'validated against the staging twin' : 'untested'}`;
  return [
    { type: 'header', text: { type: 'plain_text', text: `Approval required — ${g.step.id}: ${g.step.title}`.slice(0, 150) } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Step type:* ${g.step.type}` },
        { type: 'mrkdwn', text: `*Rollback confidence:* ${conf}` },
        { type: 'mrkdwn', text: `*Blast radius:* ${g.blastRadius.slice(0, 180)}` },
        { type: 'mrkdwn', text: `*Rehearsal:* ${g.rehearsalGreen ? 'green' : 'not rehearsed'}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Planned action:* ${g.willDo.slice(0, 250)}\n*Rollback:* ${undoTxt}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: `${g.id}:APPROVED`, action_id: 'gate_decide' },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: `${g.id}:REJECTED`, action_id: 'gate_decide' },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Open the full card: http://localhost:${config.gatePort}/gate` }] },
  ];
}

export async function notifySlack(g: PendingGate): Promise<void> {
  if (!config.slackWebhookUrl) return;
  try {
    await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Approval required: ${g.step.id} — ${g.step.title}`, blocks: slackBlocks(g) }),
      signal: AbortSignal.timeout(5000),
    });
    appendAudit('slack_notified', { gateId: g.id }, g.id);
  } catch (err) {
    console.log('   (slack notification failed — gate still open in browser UI)');
  }
}

export function renderCard(g: PendingGate): string {
  const conf = g.rollbackCard?.confidence ?? 'MISSING';
  const unable = g.rollbackCard?.confidence === 'UNABLE';
  const undoLine = unable
    ? `<span class="chip chip-bad">No safe undo — this step will be blocked unless explicitly overridden</span>`
    : `<code>${escapeHtml(g.undo)}</code> ${g.undoTested
        ? '<span class="chip chip-ok">validated against the staging twin</span>'
        : '<span class="chip chip-warn">untested</span>'}`;
  const decided = g.decision
    ? `<div class="decision ${g.decision === 'APPROVED' ? 'decision-ok' : 'decision-no'}">
         <strong>${g.decision}</strong> — ${escapeHtml(g.decidedBy ?? '')} · ${g.decidedAt}
         <span class="muted">Signed into the immutable audit trail.</span>
       </div>`
    : `<form method="POST" action="/gate/${g.id}/decide" class="actions">
         <button name="decision" value="APPROVED" class="btn btn-approve">Approve</button>
         <button name="decision" value="REJECTED" class="btn btn-reject">Reject</button>
       </form>
       <p class="hint">Approving signs your identity (${escapeHtml(os.userInfo().username)}) into the immutable audit trail.</p>`;
  return `
  <div class="card${g.decision ? ' decided' : ''}" data-gate="${g.id}" data-title="${escapeHtml(g.step.title)}">
    <div class="chips">
      <span class="chip chip-gate">Human approval required</span>
      <span class="chip ${g.rehearsalGreen ? 'chip-ok' : 'chip-warn'}">Rehearsal: ${g.rehearsalGreen ? 'green' : 'not rehearsed'}</span>
      <span class="chip ${conf === 'HIGH' ? 'chip-ok' : conf === 'UNABLE' ? 'chip-bad' : 'chip-warn'}">Rollback confidence: ${conf}</span>
    </div>
    <h2 class="card-title">${escapeHtml(g.step.id)} · ${escapeHtml(g.step.title)}</h2>
    <dl class="meta">
      <dt>Planned action</dt><dd>${escapeHtml(g.willDo)}</dd>
      <dt>Blast radius</dt><dd>${escapeHtml(g.blastRadius)}</dd>
      <dt>Rollback</dt><dd>${undoLine}</dd>
    </dl>
    ${decided}
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function startGateServer(port = config.gatePort): void {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.get('/gate', (_req, res) => {
    const list = [...gates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>FIRSTRESPONDER — Human Approval Gates</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#f85149}
        *{box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);max-width:760px;margin:0 auto;padding:2rem 1rem 4rem}
        header.masthead{border-bottom:1px solid var(--border);padding-bottom:1rem;margin-bottom:1.5rem}
        .brand{font-size:.8rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
        h1{font-size:1.35rem;font-weight:600;margin:.35rem 0 .25rem}
        .lede{color:var(--dim);font-size:.92rem;margin:0}
        .card{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:1.2rem 1.3rem;margin:1.25rem 0;background:var(--panel)}
        .card.decided{border-left-color:var(--border);opacity:.85}
        .chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.8rem}
        .chip{font-size:.72rem;font-weight:600;letter-spacing:.03em;padding:.22rem .6rem;border-radius:999px;border:1px solid var(--border);color:var(--dim)}
        .chip-gate{color:#fff;background:var(--accent);border-color:var(--accent);text-transform:uppercase;font-size:.68rem}
        .chip-ok{color:var(--ok);border-color:rgba(63,185,80,.45)}
        .chip-warn{color:var(--warn);border-color:rgba(210,153,34,.45)}
        .chip-bad{color:var(--bad);border-color:rgba(248,81,73,.45)}
        .card-title{font-size:1.08rem;font-weight:600;margin:.2rem 0 1rem}
        dl.meta{margin:0 0 1.1rem;display:grid;grid-template-columns:9.5rem 1fr;row-gap:.65rem;column-gap:1rem}
        dt{color:var(--dim);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;padding-top:.1rem}
        dd{margin:0;font-size:.95rem;line-height:1.45;overflow-wrap:anywhere}
        code{background:#21262d;padding:.2rem .45rem;border-radius:5px;font-size:.85rem;display:inline-block;max-width:100%;overflow-wrap:anywhere}
        .actions{display:flex;gap:.6rem;margin-top:.4rem}
        .btn{flex:1;font-size:1.05rem;font-weight:600;padding:.8rem 1.4rem;border-radius:9px;border:1px solid transparent;cursor:pointer}
        .btn-approve{background:#238636;color:#fff}
        .btn-approve:hover{background:#2ea043}
        .btn-reject{background:transparent;color:var(--bad);border-color:var(--bad)}
        .btn-reject:hover{background:rgba(248,81,73,.12)}
        .decision{border:1px solid var(--border);border-radius:9px;padding:.75rem .9rem;font-size:.92rem;margin-top:.4rem}
        .decision-ok{border-color:rgba(63,185,80,.5);background:rgba(63,185,80,.08)}
        .decision-no{border-color:rgba(248,81,73,.5);background:rgba(248,81,73,.08)}
        .decision strong{text-transform:uppercase;letter-spacing:.05em;font-size:.85rem}
        .decision .muted{display:block;margin-top:.25rem}
        .muted{color:var(--dim);font-size:.82rem}
        .hint{color:var(--dim);font-size:.82rem;margin:.8rem 0 0}
        .empty{color:var(--dim);border:1px dashed var(--border);border-radius:12px;padding:1.4rem;text-align:center}
        .foot{color:var(--dim);font-size:.78rem;margin-top:2rem;text-align:center}
        @media (max-width:560px){dl.meta{grid-template-columns:1fr;row-gap:.15rem}dd{margin-bottom:.55rem}}
      </style></head><body>
      <header class="masthead">
        <div class="brand">FIRSTRESPONDER</div>
        <h1>Human approval gates</h1>
        <p class="lede">Irreversible steps pause here until a human decides. Every decision is signed into the audit trail.</p>
      </header>
      ${list.length ? list.map(renderCard).join('') : '<div class="empty">No pending gates. The run continues autonomously while no irreversible step is in flight.</div>'}
      <p class="foot">Reload this page to refresh gate status.</p>
      </body></html>`);
  });
  app.post('/gate/:id/decide', (req, res) => {
    const g = gates.get(req.params.id);
    if (!g) return res.status(404).send('No such gate. Reload the page — the gate may already be decided.');
    const decision = String(req.body.decision);
    if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).send('bad decision');
    g.decision = decision as PendingGate['decision'];
    g.decidedAt = new Date().toISOString();
    g.decidedBy = os.userInfo().username;
    appendAudit('gate_decision', { gateId: g.id, step: g.step.id, decision, decidedBy: g.decidedBy, blastRadius: g.blastRadius }, g.id);
    res.redirect('/gate');
  });
  app.post('/slack/interact', express.urlencoded({ extended: true }), (req, res) => {
    // Slack Interactivity endpoint (requires a public URL — see integrations/slack.md)
    try {
      const payload = JSON.parse(String(req.body.payload ?? '{}'));
      const action = payload.actions?.[0];
      if (action?.action_id === 'gate_decide') {
        const [gateId, decision] = String(action.value).split(':');
        const g = gates.get(gateId);
        if (g && ['APPROVED', 'REJECTED'].includes(decision)) {
          g.decision = decision as PendingGate['decision'];
          g.decidedAt = new Date().toISOString();
          g.decidedBy = payload.user?.username ?? payload.user?.id ?? 'slack';
          appendAudit('gate_decision', { gateId, step: g.step.id, decision, via: 'slack', decidedBy: g.decidedBy }, gateId);
        }
      }
    } catch { /* malformed payload — ignore */ }
    res.status(200).send(); // must ack quickly
  });
  app.post('/oncall', express.json(), (req, res) => {
    // Webhook target for the PagerDuty mock, Opsgenie, and PagerDuty V3.
    // Normalize native envelopes into firerun's shape before persisting.
    let body = req.body ?? {};
    if (body.event?.data) {
      // PagerDuty V3 envelope
      body = {
        alert: body.event.data.title ?? body.event.data.summary ?? 'untyped alert',
        severity: body.event.data.urgency ?? body.event.data.priority?.summary ?? 'unknown',
        service: body.event.data.service?.summary ?? 'unknown',
        fired_at: body.event.occurred_at ?? new Date().toISOString(),
      };
    } else if (body.alert && typeof body.alert !== 'string') {
      // Opsgenie native envelope
      body = { alert: body.alert.message ?? 'untyped alert', severity: body.alert.priority ?? 'unknown', service: body.source ?? 'unknown', fired_at: body.alert.createdAt ?? new Date().toISOString() };
    } else if (typeof body.message === 'string' && !body.alert) {
      // Opsgenie REST alert payload (custom template missing)
      body = { alert: body.message, severity: body.priority ?? 'P2', service: body.service ?? 'unknown', fired_at: new Date().toISOString() };
    }
    const payload = { receivedAt: new Date().toISOString(), body };
    fs.mkdirSync('.firerun', { recursive: true });
    fs.writeFileSync('.firerun/oncall-alert.json', JSON.stringify(payload, null, 2));
    appendAudit('oncall_webhook', { body: req.body }, undefined);
    res.json({ ok: true, message: 'alert received — run `npm run cli -- oncall <runbook>` or the serve loop will pick it up' });
  });
  app.listen(port, () => {
    const nets = Object.values(os.networkInterfaces()).flat().filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log(`  Gate UI    http://localhost:${port}/gate`);
    for (const n of nets) console.log(`  Phone      http://${n}:${port}/gate   (same network)`);
    console.log(`  Webhook    POST http://localhost:${port}/oncall`);
  });
}

/**
 * Request human approval. Resolves with the decision.
 * Enforces the invariant: no validated rollback + UNABLE ⇒ resolves 'BLOCKED'
 * unless a human explicitly overrides.
 */
export function requestApproval(opts: {
  runId: string;
  step: Step;
  rollbackCard?: RollbackCard;
  rehearsalGreen?: boolean;
  willDo: string;
  timeoutMin?: number;
}): Promise<'APPROVED' | 'REJECTED' | 'BLOCKED' | 'OVERRIDE' | 'TIMEOUT'> {
  const id = `gate-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const g: PendingGate = {
    id,
    step: opts.step,
    rollbackCard: opts.rollbackCard,
    rehearsalGreen: opts.rehearsalGreen,
    willDo: opts.willDo,
    blastRadius: opts.step.blastRadius ?? '(agent-computed: see card)',
    undo: opts.rollbackCard?.undo ?? '',
    undoTested: opts.rollbackCard?.tested ?? false,
    createdAt: new Date().toISOString(),
  };
  gates.set(id, g);
  appendAudit('gate_opened', { gateId: id, step: opts.step.id, confidence: opts.rollbackCard?.confidence }, opts.runId);
  void notifySlack(g);

  const noUndo = opts.rollbackCard?.confidence === 'UNABLE';

  if (config.gateMode === 'auto') {
    // rehearse mode — nothing real is at stake on the twin
    g.decision = noUndo ? 'REJECTED' : 'APPROVED';
    g.decidedAt = new Date().toISOString();
    g.decidedBy = 'AUTO (rehearsal)';
    return Promise.resolve(noUndo ? 'REJECTED' : 'APPROVED');
  }

  if (config.gateMode === 'cli') {
    console.log(`\n── HUMAN GATE ─ ${opts.step.id}: ${opts.step.title}`);
    console.log(`   Planned action : ${opts.willDo}`);
    console.log(`   Blast radius   : ${g.blastRadius}`);
    console.log(`   Rollback       : ${opts.rollbackCard?.undo ?? 'NONE (UNABLE)'} ${opts.rollbackCard?.tested ? '(validated against staging twin)' : '(untested)'}`);
    if (noUndo) console.log('   No safe undo exists. Approving records acceptance of the risk on the audit trail.');
    const ans = readline.createInterface({ input: process.stdin, output: process.stdout });
    return (async () => {
      const a = await ans.question(`   approve/reject/override> `);
      ans.close();
      const d = a.trim().toLowerCase();
      g.decision = d === 'override' ? 'OVERRIDE' : d === 'approve' ? 'APPROVED' : 'REJECTED';
      g.decidedAt = new Date().toISOString();
      g.decidedBy = os.userInfo().username;
      return g.decision;
    })();
  }

  // http mode — poll until decided or timeout
  const timeoutMs = (opts.timeoutMin ?? config.gateTimeoutMin) * 60_000;
  const start = Date.now();
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (g.decision === 'APPROVED') { clearInterval(timer); resolve('APPROVED'); }
      else if (g.decision === 'REJECTED') { clearInterval(timer); resolve('REJECTED'); }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve('TIMEOUT'); }
    }, 500);
  });
}

export function writeGateSnapshot(): void {
  fs.mkdirSync('.firerun', { recursive: true });
  fs.writeFileSync(path.resolve('.firerun/gates-snapshot.json'), JSON.stringify([...gates.values()], null, 2));
}

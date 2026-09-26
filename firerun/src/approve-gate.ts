/**
 * Gate approver — the terminal fallback for the phone.
 *
 *   npm run gate:watch                # poll + show pending gates
 *   npm run gate:approve              # approve the newest pending gate
 *   npm run gate:reject               # reject it
 *
 * Talks to the same gate server the phone browser uses — identical audit
 * semantics, identical decision record.
 */
import { config, loadEnv } from './config.js';

loadEnv();
const GATE = `http://localhost:${config.gatePort}`;

const mode = (process.argv[2] ?? 'watch').toLowerCase(); // watch | approve | reject

interface PendingGate { id: string; step: { id: string; title: string }; decision?: string }

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function pendingGates(): Promise<PendingGate[]> {
  const html = await (await fetch(`${GATE}/gate`)).text();
  const out: PendingGate[] = [];
  const re = /data-gate="([^"]+)" data-title="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const id = m[1];
    const decided = new RegExp(`class="card decided" data-gate="${id}"`).test(html);
    out.push({ id, step: { id, title: decode(m[2]) }, decision: decided ? 'decided' : undefined });
  }
  return out;
}

async function decide(id: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const res = await fetch(`${GATE}/gate/${id}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `decision=${decision}`,
    redirect: 'manual',
  });
  console.log(`${id} → ${decision} (HTTP ${res.status})`);
}

const gates = await pendingGates();
if (!gates.length) {
  console.log('No gates pending. (Is an execute run in progress?)');
  process.exit(0);
}
const open = gates.filter(g => !g.decision);
for (const g of gates) console.log(`  ${g.decision ? '·' : '[open]'} ${g.id} — ${g.step.title}`);

const target = open.at(-1);
if (!target) { console.log('All gates already decided.'); process.exit(0); }
if (mode === 'approve') await decide(target.id, 'APPROVED');
else if (mode === 'reject') await decide(target.id, 'REJECTED');
else console.log(`→ npm run gate:approve   (or approve from your phone: the LAN URL printed by the run)`);

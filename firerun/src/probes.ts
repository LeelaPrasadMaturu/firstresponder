import { config } from './config.js';
import type { Probe } from './types.js';

/**
 * PROBE RUNTIME — verification contracts, executed outside the model.
 * The agent may AUTHOR probes; the runtime RUNS them and decides pass/fail.
 */

export interface ProbeResult {
  probe: Probe;
  ok: boolean;
  detail: string;
}

function evalRows(actual: number, expect?: string): { ok: boolean; detail: string } {
  if (!expect) return { ok: true, detail: `rows=${actual}` };
  const m = expect.match(/^([<>=]+)\s*(\d+)$/);
  if (!m) return { ok: actual > 0, detail: `rows=${actual}, expected pattern "${expect}"` };
  const [, op, nStr] = m;
  const n = Number(nStr);
  const ok = op === '>' ? actual > n : op === '<' ? actual < n : op === '>=' ? actual >= n : op === '<=' ? actual <= n : actual === n;
  return { ok, detail: `rows=${actual}, expected ${op}${n}` };
}

export async function runProbe(probe: Probe, target: { appUrl: string; dbUrl: string }): Promise<ProbeResult> {
  try {
    switch (probe.kind) {
      case 'http': {
        const res = await fetch(new URL(probe.target, target.appUrl).toString(), { signal: AbortSignal.timeout(10_000) });
        const body = await res.text();
        const okStatus = !probe.expectStatus || res.status === probe.expectStatus;
        const okContains = !probe.expectContains || body.includes(probe.expectContains);
        return { probe, ok: okStatus && okContains, detail: `status=${res.status}${probe.expectContains ? `, contains=${okContains}` : ''}` };
      }
      case 'content': {
        // Front-of-glass probe: page must render AND carry the expected content.
        const res = await fetch(new URL(probe.target, target.appUrl).toString(), { signal: AbortSignal.timeout(10_000) });
        const body = await res.text();
        const renderedOk = res.status === 200 && body.length > 100 && !body.includes('__FIRERUN_BROKEN_PAGE__');
        const containsOk = !probe.expectContains || body.includes(probe.expectContains);
        return { probe, ok: renderedOk && containsOk, detail: `status=${res.status}, bytes=${body.length}, contains=${containsOk}` };
      }
      case 'db': {
        const { default: pg } = await import('pg');
        const c = new pg.Client({ connectionString: target.dbUrl });
        await c.connect();
        try {
          const r = await c.query(probe.target);
          const n = r.rows[0] ? Number(Object.values(r.rows[0])[0]) : (r.rowCount ?? 0);
          const { ok, detail } = evalRows(n, probe.expectRows);
          return { probe, ok, detail };
        } finally {
          await c.end();
        }
      }
      case 'command': {
        const { execFileSync } = await import('node:child_process');
        const out = execFileSync('bash', ['-c', probe.target], {
          cwd: config.sandboxDir, timeout: 15_000, encoding: 'utf8', maxBuffer: 1024 * 256,
          env: {
            ...process.env,
            APP_URL: target.appUrl, DATABASE_URL: target.dbUrl,
            PROD_APP_URL: config.prodAppUrl, PROD_DB_URL: config.prodDbUrl,
            TWIN_APP_URL: config.twinAppUrl, TWIN_DB_URL: config.twinDbUrl,
            CLUSTER_B_APP_URL: config.clusterBAppUrl,
          },
        });
        const ok = !probe.expectContains || out.includes(probe.expectContains);
        return { probe, ok, detail: out.slice(0, 300) || 'exit 0' };
      }
      default:
        return { probe, ok: false, detail: `unknown probe kind ${probe.kind}` };
    }
  } catch (err) {
    return { probe, ok: false, detail: String(err instanceof Error ? err.message : err).slice(0, 200) };
  }
}

export async function runProbes(
  probes: Probe[],
  target: { appUrl: string; dbUrl: string },
  twinTarget?: { appUrl: string; dbUrl: string },
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const p of probes) {
    const t = p.twin && twinTarget ? twinTarget : target;
    results.push(await runProbe(p, t));
  }
  return results;
}

export function renderProbeResults(results: ProbeResult[]): string {
  return results.map(r => `  ${r.ok ? '✅' : '❌'} [${r.probe.kind}] ${r.probe.target.slice(0, 70)} — ${r.detail}`).join('\n');
}

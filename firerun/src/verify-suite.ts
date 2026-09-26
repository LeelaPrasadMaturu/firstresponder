// demo:verify — headless end-to-end sanity check of the whole Stage.
// Runs in seconds, no LLM needed. Use before every demo.
import { config, loadEnv, ensureDirs } from './config.js';
import { compileRunbook } from './compiler.js';
import { runProbes } from './probes.js';
import { verifyChain } from './audit.js';

loadEnv();
ensureDirs();

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

async function url(url: string, expect: { status?: number; contains?: string }): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    return (!expect.status || res.status === expect.status) && (!expect.contains || body.includes(expect.contains));
  } catch { return false; }
}

async function main(): Promise<void> {
  console.log('\n🧪 FIRSTRESPONDER — Stage verification suite\n');

  // 1. Stage reachable
  check('prod app up', await url(`${config.prodAppUrl}/healthz`, { status: 200 }));
  check('twin app up', await url(`${config.twinAppUrl}/healthz`, { status: 200 }));
  check('cluster-b up (standby)', await url(`${config.clusterBAppUrl}/admin/state`, { status: 200, contains: 'standby' }));
  check('prod pages render', await url(`${config.prodAppUrl}/pricing`, { contains: 'Plans' }));
  check('slo endpoint live', await url(`${config.prodAppUrl}/slo`, { contains: 'slo_' }));

  // 2. DB reachable + seeded
  const dbProbes = await runProbes(
    [{ kind: 'db', target: 'SELECT count(*) FROM orders', expectRows: '>0' },
     { kind: 'db', target: 'SELECT count(*) FROM cache_shards WHERE corrupted', expectRows: '>0' },
     { kind: 'db', target: 'SELECT count(*) FROM legacy_topics', expectRows: '=5' },
     { kind: 'db', target: 'SELECT count(*) FROM legacy_pvs', expectRows: '=2' }],
    { appUrl: config.prodAppUrl, dbUrl: config.prodDbUrl });
  check('prod db seeded (orders, corrupted shard, legacy stack)', dbProbes.every(r => r.ok), dbProbes.map(r => r.detail).join('; '));

  // 3. Compiler parses all runbooks deterministically
  const books = [
    '../the-stage/runbooks/incident-memory-leak.md',
    '../the-stage/runbooks/canary-memory-guard.md',
    '../the-stage/runbooks/release-rollout.md',
    '../the-stage/runbooks/latency-spike.md',
    '../the-stage/runbooks/infra-orphan-cleanup.md',
    '../the-stage/runbooks/deploy-app.md',
    '../the-stage/runbooks/deploy-registry.md',
    '../the-stage/runbooks/migrate-orders.md',
    '../the-stage/runbooks/infra-move.md',
    '../the-stage/runbooks/cleanup-raw-events-refusal-demo.md',
    '../the-stage/runbooks/infra-monitor.md',
    '../the-stage/runbooks/infra-scale-up.md',
    '../the-stage/runbooks/infra-scale-down.md',
    '../the-stage/runbooks/infra-delete.md',
  ];
  for (const b of books) {
    try {
      const g = await compileRunbook(b, { useAgent: false });
      const gates = g.steps.filter(s => s.gate).length;
      check(`compile ${b.split('/').pop()}`, g.steps.length > 0, `${g.steps.length} steps, ${gates} gate(s)`);
    } catch (err) {
      check(`compile ${b.split('/').pop()}`, false, String(err).slice(0, 120));
    }
  }

  // 4. Audit chain intact
  const chain = verifyChain();
  check('audit chain HMAC', chain.ok, chain.ok ? `${'records verified'}` : `broken at seq ${chain.brokenAt}`);

  console.log(failed === 0 ? '\n🎯 Stage is demo-ready.\n' : `\n💥 ${failed} check(s) failed — is \`docker compose up -d\` running in the-stage/?\n`);
  if (failed > 0) process.exit(1);
}

main();

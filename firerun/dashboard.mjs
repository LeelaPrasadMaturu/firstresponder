// ─────────────────────────────────────────────────────────────────────────────
// FIRERUN NOC — a Grafana/Prometheus-style observability console for the demo.
//
// Nothing here is mocked. Every panel binds to a real signal:
//   · Prometheus text metrics scraped live from prod / twin / cluster-B
//     (the same scrape loop that drives the choreographed leak: +8MB/scrape)
//   · Execution Graphs compiled from the-stage/runbooks/*.graph.json
//   · Real run states from .firerun/runs/*/state.json
//   · Live HMAC-chained audit stream from .firerun/AUDIT.jsonl
//   · Flywheel receipts via git log in the the-stage repo
//   · Open approval gates from .firerun/gates-snapshot.json
//
// Run:  npm run dashboard   →  http://localhost:8095
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FIRERUN_DASH_PORT ?? 8095);
const SCRAPE_MS = Number(process.env.FIRERUN_SCRAPE_MS ?? 2000);
const MAX_POINTS = 900; // ~30 min of ring buffer at 2s

const TARGETS = [
  { id: 'prod',  name: 'signer-prod',  url: process.env.PROD_APP_URL  ?? 'http://localhost:18080', role: 'PROD',     color: '#f85149' },
  { id: 'twin',  name: 'staging-twin', url: process.env.TWIN_APP_URL  ?? 'http://localhost:18081', role: 'TWIN',     color: '#3fb950' },
  { id: 'clB',   name: 'cluster-b',    url: process.env.CLUSTER_B_APP_URL ?? 'http://localhost:18082', role: 'STANDBY', color: '#58a6ff' },
];
const RUNBOOKS_DIR = path.resolve(__dirname, '../the-stage/runbooks');
let consoleLog = null; // latest console-started run log
const STAGE_DIR = path.resolve(__dirname, '../the-stage');
const FIRERUN_DIR = path.resolve(__dirname, '.firerun');

// ── Prometheus text-format parser ────────────────────────────────────────────
function parsePromText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+(-?[\d.eE+]+)$/);
    if (!m) continue;
    const name = m[1].replace(/\{.*\}/, '');
    const val = Number(m[2]);
    if (Number.isFinite(val)) out[name] = val;
    if (name === 'app_version') {
      const lbl = m[1].match(/version="([^"]+)"/);
      if (lbl) out._version = lbl[1];
    }
  }
  return out;
}

// ── TSDB-style in-memory ring buffers ────────────────────────────────────────
const series = new Map(); // `${targetId}:${metric}` → [{t, v}]
const latest = new Map(); // targetId → { metrics, state, slo, health, lastOk, err }
function push(key, t, v) {
  if (!series.has(key)) series.set(key, []);
  const arr = series.get(key);
  arr.push({ t, v });
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
}

async function fetchJson(url, ms = 2500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// side probes: gate server, OCI registry, corrupted-shard count (real DB query), real container RSS
const side = { gateUp: false, registryUp: false, shards: 0, dockerMem: {} };
function parseMem(s) { const m = String(s).match(/^([\d.]+)(KiB|MiB|GiB)/); if (!m) return 0;
  const v = parseFloat(m[1]); return m[2] === 'GiB' ? v * 1024 : m[2] === 'KiB' ? v / 1024 : v; }
async function probeSide() {
  try { const r = await fetch('http://localhost:17788/gate', { signal: AbortSignal.timeout(1500) }); side.gateUp = r.ok; } catch { side.gateUp = false; }
  try { const r = await fetch('http://localhost:15555/v2/', { signal: AbortSignal.timeout(1500) }); side.registryUp = r.status < 500; } catch { side.registryUp = false; }
  execFile('docker', ['exec', 'prod-db', 'psql', '-U', 'stage', '-d', 'stagedb', '-tA', '-c',
    'SELECT count(*) FROM cache_shards WHERE corrupted'], (err, stdout) => {
    if (!err) { const n = parseInt(stdout.trim(), 10); if (Number.isFinite(n)) side.shards = n; }
  });
  // kernel-level truth: actual container RSS from docker (nothing faked)
  execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}'], (err, stdout) => {
    if (err) return;
    for (const line of String(stdout).trim().split('\n')) {
      const [name, usage] = line.split(/\s+/);
      if (name && usage) side.dockerMem[name] = Math.round(parseMem(usage));
    }
  });
}

let scraping = false;
async function scrape() {
  if (scraping) return;
  scraping = true;
  const now = Date.now();
  await Promise.all(TARGETS.map(async (tg) => {
    try {
      const [metricsTxt, state, slo, health] = await Promise.all([
        fetch(`${tg.url}/metrics`, { signal: AbortSignal.timeout(2500) }).then(r => r.text()),
        fetchJson(`${tg.url}/admin/state`).catch(() => null),
        fetchJson(`${tg.url}/slo`).catch(() => null),
        fetchJson(`${tg.url}/healthz`).catch(() => null),
      ]);
      const m = parsePromText(metricsTxt);
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'number') push(`${tg.id}:${k}`, now, v);
      }
      latest.set(tg.id, { metrics: m, state, slo, health, lastOk: now, err: null });
    } catch (e) {
      const prev = latest.get(tg.id) ?? {};
      latest.set(tg.id, { ...prev, lastOk: prev.lastOk ?? 0, err: String(e.message ?? e) });
    }
  }));
  scraping = false;
}
scrape();
probeSide();
setInterval(scrape, SCRAPE_MS);
setInterval(probeSide, Math.max(SCRAPE_MS * 4, 8000));

// ── Runbooks + runs + audit + git + gates ────────────────────────────────────
function loadRunbooks() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.graph.json')); } catch { return out; }
  // latest run per runbook
  const runs = [];
  try {
    for (const d of fs.readdirSync(path.join(FIRERUN_DIR, 'runs'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(FIRERUN_DIR, 'runs', d, 'state.json'), 'utf8'));
        runs.push({
          runId: s.runId, mode: s.mode, startedAt: s.startedAt, green: s.green,
          runbook: s.graph?.runbook ?? '',
          steps: (s.results ? Object.entries(s.results) : []).map(([id, r]) => ({ id, status: r.status, gate: r.gateDecision ?? null })),
        });
      } catch {}
    }
  } catch {}
  for (const f of files) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(RUNBOOKS_DIR, f), 'utf8'));
      const steps = g.steps ?? [];
      const byType = {};
      for (const s of steps) byType[s.type] = (byType[s.type] ?? 0) + 1;
      const rel = g.runbook?.split('/').pop() ?? f.replace('.graph.json', '.md');
      const myRuns = runs.filter(r => r.runbook.endsWith(rel)).sort((a, b) => b.startedAt - a.startedAt);
      let addenda = 0;
      try {
        const md = fs.readFileSync(path.join(RUNBOOKS_DIR, rel), 'utf8');
        addenda = (md.match(/firerun-addendum/g) ?? []).length;
      } catch {}
      out.push({
        file: rel, title: g.title ?? rel, revision: g.revision ?? '?',
        steps: steps.length, gates: steps.filter(s => s.gate).length, byType,
        lastRun: myRuns[0] ?? null, runCount: myRuns.length, addenda,
      });
    } catch {}
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function loadAudit(n = 70) {
  try {
    const lines = fs.readFileSync(path.join(FIRERUN_DIR, 'AUDIT.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

function loadGates() {
  try { return JSON.parse(fs.readFileSync(path.join(FIRERUN_DIR, 'gates-snapshot.json'), 'utf8')); }
  catch { return []; }
}

function gitLog(cb) {
  execFile('git', ['-C', STAGE_DIR, 'log', '--pretty=format:%h|%s|%cr', '-6'], (err, stdout) => {
    cb(err ? [] : stdout.split('\n').map(l => { const [h, s, ...r] = l.split('|'); return { hash: h, subject: s, when: r.join('|') }; }));
  });
}

// ── API ──────────────────────────────────────────────────────────────────────
function seriesPayload() {
  const o = {};
  for (const [k, arr] of series) o[k] = arr.slice(-MAX_POINTS);
  return o;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(body);
  };
  try {
    if (url.pathname === '/api/snapshot') {
      gitLog(commits => {
        send(200, JSON.stringify({
          now: Date.now(),
          targets: TARGETS.map(t => ({ ...t, ...latest.get(t.id), url: t.url })),
          series: seriesPayload(),
          runbooks: loadRunbooks(),
          audit: loadAudit(),
          gates: loadGates(),
          commits,
          gateUp: side.gateUp,
          registryUp: side.registryUp,
          shards: side.shards,
          dockerMem: side.dockerMem,
        }));
      });
      return;
    }
    // demo choreography controls — real POSTs to the prod admin API
    if (url.pathname === '/api/control' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { action } = JSON.parse(body || '{}');
          const prod = TARGETS[0].url;
          const map = {
            'deploy-leaky':   [`${prod}/admin/deploy`, { version: 'v2.1.0' }],
            'deploy-good':    [`${prod}/admin/deploy`, { version: 'v1.42.0' }],
            'traffic-spike':  [`${prod}/admin/traffic`, { rps: 4200 }],
            'traffic-normal': [`${prod}/admin/traffic`, { rps: 1000 }],
            'scale-up':       [`${prod}/admin/scale`, { replicas: 14 }],
            'scale-down':     [`${prod}/admin/scale`, { replicas: 4 }],
          };
          const [ep, payload] = map[action] ?? [null, null];
          if (!ep) return send(400, JSON.stringify({ error: 'unknown action' }));
          const r = await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(4000) });
          send(r.status, await r.text());
          scrape();
        } catch (e) { send(502, JSON.stringify({ error: String(e.message ?? e) })); }
      });
      return;
    }
    if (url.pathname === '/alerts' || url.pathname === '/agents' || url.pathname === '/') {
      try {
        return send(200, fs.readFileSync(path.resolve(__dirname, '../dashboard/alert-dashboard.html')), 'text/html; charset=utf-8');
      } catch { return send(404, 'alert-dashboard.html not found next to the repo root'); }
    }
    if (url.pathname === '/lab') {
      try {
        return send(200, fs.readFileSync(path.resolve(__dirname, '../dashboard/alert-lab.html')), 'text/html; charset=utf-8');
      } catch { return send(404, 'alert-lab.html not found next to the repo root'); }
    }
    if (url.pathname === '/noc') {
      // legacy NOC console — optional big-screen memory view
      return send(200, html(), 'text/html; charset=utf-8');
    }

    // ── Run Console: drive the demo from the dashboard, no terminal needed ──
    if (url.pathname === '/api/cmd' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const { cmd } = JSON.parse(body || '{}');
        const out = (s) => send(200, JSON.stringify({ ok: true, output: String(s) }));
        const c = String(cmd ?? '').trim();
        if (!c) return send(400, JSON.stringify({ ok: false, error: 'empty command' }));
        const [head, ...rest] = c.split(/\s+/);
        const arg = rest.join(' ');
          const num = (v, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`expected int ${lo}–${hi}`); return n; };
          const ver = (v) => { if (!/^v\d+\.\d+\.\d+$/.test(v)) throw new Error('expected version like v2.1.0'); return v; };

        const RB = /^(\.\.\/)?the-stage\/runbooks\/[\w.-]+\.md$/;
        try {
          // release-rollout composite: twin-first fix rollout with the human gate
          if (head === 'rollout') {
            const log = `/tmp/firerun-console-${Date.now()}.log`;
            const script = 'npx tsx src/cli.ts rehearse ../the-stage/runbooks/release-rollout.md && npx tsx src/cli.ts execute ../the-stage/runbooks/release-rollout.md';
            const child = spawn('bash', ['-lc', script], {
              cwd: __dirname, detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
              env: { ...process.env },
            });
            child.unref();
            consoleLog = log;
            return out('▶ ROLLOUT FLOW started: baseline → fix on TWIN → verify → soak analysis (Daytona) → YOUR APPROVAL GATE → prod. Approve at the gate / on your phone when the card appears.');
          }
          // leak lab: request simulator — hits prod /metrics per-burst (each scrape = +8MB while leaky)
          if (head === 'simulate') {
            const [per, iv, bursts] = arg.split(/\s+/);
            const nPer = num(per ?? '3', 1, 50), nIv = num(iv ?? '2', 1, 60), nB = num(bursts ?? '20', 1, 500);
            const script = `for i in $(seq 1 ${nB}); do for j in $(seq 1 ${nPer}); do curl -s -o /dev/null http://localhost:18080/metrics; done; echo "burst $i/${nB} done"; sleep ${nIv}; done; echo SIMULATION-COMPLETE`;
            fs.writeFileSync('/tmp/firerun-sim.sh', script);
            const child = spawn('bash', ['/tmp/firerun-sim.sh'], { detached: true, stdio: ['ignore', fs.openSync('/tmp/firerun-sim.log', 'w'), 'ignore'] });
            child.unref();
            fs.writeFileSync('/tmp/firerun-sim.pid', String(child.pid));
            return out(`🧪 LOAD SIMULATOR started (pid ${child.pid}): ${nPer} requests every ${nIv}s × ${nB} bursts against the live release. Watch the memory chart and kernel RSS on the dashboard — what climbs is real.`);
          }
          if (head === 'simstop') {
            try {
              const pid = fs.readFileSync('/tmp/firerun-sim.pid', 'utf8').trim();
              process.kill(Number(pid), 'SIGTERM');
              return out(`🧪 simulator (pid ${pid}) stopped.`);
            } catch { return out('no simulator running'); }
          }
          // scenario arming: node pools
          if (head === 'pool') {
            const [name, size] = arg.split(/\s+/);
            if (!/^[a-z-]+$/.test(name ?? '') || !/^\d+$/.test(size ?? '')) return out('usage: pool <name> <size>  (e.g. pool event-pool 6)');
            return post(`${'http://localhost:18080'}/admin/pools`, { name, size: Number(size) });
          }
          // composite demo flows: rehearse → execute chained, one click
          if (head === 'canary' || head === 'incident') {
            const rb = head === 'canary' ? 'canary-memory-guard.md' : 'incident-memory-leak.md';
            const log = `/tmp/firerun-console-${Date.now()}.log`;
            const script = `npx tsx src/cli.ts rehearse ../the-stage/runbooks/${rb} && npx tsx src/cli.ts execute ../the-stage/runbooks/${rb}`;
            const child = spawn('bash', ['-lc', script], {
              cwd: __dirname, detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
              env: { ...process.env },
            });
            child.unref();
            consoleLog = log;
            return out(`▶ ${head.toUpperCase()} FLOW started: rehearse → execute ${rb} (pid ${child.pid})${head === 'incident' ? ' — phone gate will open at the irreversible step' : ' — fully autonomous, zero gates'}`);
          }
          // long-running runbook commands → background + streamed log
          if (['oncall', 'execute', 'rehearse', 'compile', 'serve'].includes(head)) {
            const rb = arg.replace(/^\.\.\//, '../');
            if (!RB.test(rb)) return send(400, JSON.stringify({ ok: false, error: `usage: ${head} ../the-stage/runbooks/<name>.md` }));
            const log = `/tmp/firerun-console-${Date.now()}.log`;
            const child = spawn('npx', ['tsx', 'src/cli.ts', head, rb], {
              cwd: __dirname, detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
              env: { ...process.env },
            });
            child.unref();
            consoleLog = log;
            return out(`▶ started '${head} ${rb}' (pid ${child.pid}) — streaming to console…`);
          }
          const prod = 'http://localhost:18080';
          const post = (ep, payload) => execFile('curl', ['-s', '-XPOST', ep, '-H', 'content-type: application/json', '-d', JSON.stringify(payload)], { timeout: 8000 }, (e, so, se) => out(String(so || se || e)));
          switch (head) {
            case 'help': return out(
`FIRERUN console — commands:
  canary                   🛡 rehearse+execute the canary guard (autonomous, no gates)
  rollout                  🚦 twin-first fix rollout: verify on twin → Daytona soak → YOUR gate → prod
  simulate <n> <sec> <bursts>  🧪 leak lab: N requests every S sec × B bursts (+8MB/scrape while leaky)
  simstop                  stop the simulator
  pool <name> <size>       arm/clear node pools (e.g. pool event-pool 6 — the forgotten min-instances)
  incident                 🚨 rehearse+execute the incident runbook (phone gate at step-7)
  oncall|execute|rehearse|compile <../the-stage/runbooks/<name>.md>   run the runtime (streams here)
  deploy <vX.Y.Z>          put prod on a release (v2.1.0 = leaky)
  rollback                 deploy v1.42.0 (last known-good)
  traffic <rps>            set traffic load (try 4200)
  scale <n>                set replica count (4..20)
  reset                    fresh leaky incident state
  verify                   9-point stage verification
  audit                    tail the HMAC audit chain
  git log                  flywheel receipts
  agents                   registered TrueForge agents`);
            case 'deploy': return post(`${prod}/admin/deploy`, { version: ver(arg) });
            case 'rollback': return post(`${prod}/admin/deploy`, { version: 'v1.42.0' });
            case 'traffic': return post(`${prod}/admin/traffic`, { rps: num(arg, 0, 20000) });
            case 'scale': return post(`${prod}/admin/scale`, { replicas: num(arg, 0, 500) });
            case 'reset': {
              execFile('docker', ['compose', '-f', '../the-stage/docker-compose.yml', 'restart', 'app'], { timeout: 60000 }, () => {
                setTimeout(() => post(`${prod}/admin/deploy`, { version: 'v2.1.0' }), 2500);
              });
              return out('restarting prod-app → deploying v2.1.0 (leaky)…');
            }
            case 'verify': {
              execFile('npx', ['tsx', 'src/verify-suite.ts'], { cwd: __dirname, timeout: 60000, maxBuffer: 1e6 }, (e, so, se) => out(String(so || se || e)));
              return;
            }
            case 'audit': {
              const lines = fs.readFileSync(path.join('.firerun', 'AUDIT.jsonl'), 'utf8').trim().split('\n').slice(-12);
              return out(lines.map(l => { try { const j = JSON.parse(l); return `${j.ts?.slice(11,19)} ${j.event} ${JSON.stringify(j.payload ?? {}).slice(0, 110)}`; } catch { return l.slice(0, 140); } }).join('\n'));
            }
            case 'git': {
              if (arg !== 'log') return out('usage: git log');
              return execFile('git', ['-C', '../the-stage', 'log', '--oneline', '-8'], { timeout: 5000 }, (e, so) => out(String(so || e)));
            }
            case 'agents': {
              fetch('http://localhost:8790/api/v1/agents').then(r => r.json()).then(j =>
                out((j.data ?? []).map(a => a.name).join('\n'))).catch(e => out(String(e)));
              return;
            }
            default: return send(400, JSON.stringify({ ok: false, error: `unknown command '${head}' — try 'help'` }));
          }
        } catch (e) {
          send(400, JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
      });
      return;
    }
    if (url.pathname === '/api/runlog') {
      let text = '(no run started from the console yet)';
      if (consoleLog) { try { const buf = fs.readFileSync(consoleLog, 'utf8'); text = buf.length > 24000 ? '…' + buf.slice(-24000) : buf; } catch { /* warming up */ } }
      return send(200, JSON.stringify({ log: consoleLog ?? null, text }));
    }
    send(404, JSON.stringify({ error: 'not found' }));
  } catch (e) { send(500, JSON.stringify({ error: String(e) })); }
});

server.listen(PORT, () => {
  console.log(`\firescreen FIRERUN NOC console → http://localhost:${PORT}  (scraping every ${SCRAPE_MS}ms)`);
  console.log(`firescreen Alert Command Center → http://localhost:${PORT}/alerts`);
  for (const t of TARGETS) console.log(`   · scraping ${t.role.padEnd(7)} ${t.url}/metrics`);
});

// ── The UI ───────────────────────────────────────────────────────────────────
function html() { return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FIRERUN NOC — signer-prod</title>
<style>
:root{--bg:#0b0e14;--panel:#11151c;--panel2:#0d1117;--edge:#1f2630;--txt:#c9d1d9;--dim:#8b949e;--red:#f85149;--green:#3fb950;--yellow:#d29922;--blue:#58a6ff;--purple:#bc8cff;--cyan:#39d2c0}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:13px/1.45 -apple-system,'SF Mono',Menlo,monospace;padding:14px}
header{display:flex;align-items:center;gap:14px;padding:10px 14px;background:var(--panel);border:1px solid var(--edge);border-radius:10px;margin-bottom:12px;flex-wrap:wrap}
.logo{font-weight:800;font-size:15px;letter-spacing:1px;color:var(--cyan)}
.logo b{color:var(--purple)}
.pill{padding:3px 10px;border-radius:20px;border:1px solid var(--edge);font-size:11px;white-space:nowrap}
.pill.ok{color:var(--green);border-color:#1d4428;background:#0f1f14}
.pill.bad{color:var(--red);border-color:#5c1a1a;background:#2a0e0e;animation:pulse 1.2s infinite}
.pill.warn{color:var(--yellow);border-color:#4d3a10;background:#241c07}
.pill.info{color:var(--blue)}
@keyframes pulse{50%{opacity:.55}}
.spacer{flex:1}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.panel{background:var(--panel);border:1px solid var(--edge);border-radius:10px;padding:12px;min-width:0}
.panel h3{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--dim);margin-bottom:8px;display:flex;align-items:center;gap:8px}
.panel h3 .dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
.panel h3 .dot.down{background:var(--red);animation:pulse 1s infinite}
.big{grid-column:span 8}.half{grid-column:span 6}.third{grid-column:span 4}.quarter{grid-column:span 3}.full{grid-column:span 12}
canvas{width:100%;display:block}
.kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed #161c26}
.kv:last-child{border:0}
.kv span:first-child{color:var(--dim)}
.v-red{color:var(--red);font-weight:700}.v-green{color:var(--green)}.v-yellow{color:var(--yellow)}.v-blue{color:var(--blue)}
.gauge{margin:6px 0}
.gauge .bar{height:10px;background:#161c26;border-radius:6px;overflow:hidden;position:relative}
.gauge .fill{height:100%;border-radius:6px;transition:width .6s}
.gauge .oom{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--red);left:100%}
.gauge .lbl{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-top:2px}
.rb{border:1px solid var(--edge);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:var(--panel2)}
.rb .t{font-weight:700;color:var(--txt);font-size:12px}
.rb .m{color:var(--dim);font-size:11px;margin:3px 0}
.chip{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;margin-right:4px;border:1px solid}
.chip.READ{color:var(--blue);border-color:#1f4470}
.chip.ACT_REVERSIBLE{color:var(--green);border-color:#1d4428}
.chip.ACT_IRREVERSIBLE{color:var(--red);border-color:#5c1a1a}
.chip.VERIFY{color:var(--purple);border-color:#4c3a75}
.feed{max-height:250px;overflow-y:auto;font-size:11px}
.ev{padding:4px 6px;border-left:2px solid var(--edge);margin-bottom:3px;background:var(--panel2);border-radius:0 6px 6px 0}
.ev b{color:var(--cyan)}
.ev.gate{border-left-color:var(--red)} .ev.gate b{color:var(--red)}
.ev.good{border-left-color:var(--green)} .ev.good b{color:var(--green)}
.ev .t{color:var(--dim);float:right}
.commit{padding:3px 0;border-bottom:1px dashed #161c26;font-size:11px}
.commit .h{color:var(--purple)} .commit .w{color:var(--dim);float:right}
.ctrls{display:flex;flex-wrap:wrap;gap:6px}
button{background:#161c26;color:var(--txt);border:1px solid var(--edge);border-radius:6px;padding:6px 10px;font:11px Menlo;cursor:pointer}
button:hover{border-color:var(--cyan);color:var(--cyan)}
button.danger{border-color:#5c1a1a;color:var(--red)}
#gatebanner{display:none;background:#2a0e0e;border:1px solid var(--red);border-radius:10px;padding:14px;margin-bottom:12px;animation:pulse 1.4s infinite}
#gatebanner h2{color:var(--red);font-size:15px;margin-bottom:4px}
footer{color:var(--dim);font-size:10px;margin-top:14px;text-align:center}
@media(max-width:1100px){.big,.half,.third,.quarter{grid-column:span 12}}
</style></head><body>

<div id="gatebanner"><h2>⛔ APPROVAL GATE OPEN — execution paused</h2><div id="gatedetail"></div></div>

<header>
  <div class="logo">🔥 FIRERUN<b>NOC</b></div>
  <div id="hProd" class="pill bad">PROD — connecting…</div>
  <div id="hTwin" class="pill ok">TWIN</div>
  <div id="hCl" class="pill info">CLUSTER-B</div>
  <div class="spacer"></div>
  <div id="clock" class="pill info"></div>
  <div id="scrape" class="pill">scrape 2s</div>
</header>

<div class="grid">
  <div class="panel big">
    <h3><span class="dot" id="dMem"></span>Application memory — prod vs staging twin (MB) · <span style="color:var(--red)">red line = 512 OOM threshold</span></h3>
    <canvas id="cMem" height="240"></canvas>
    <div class="gauge"><div class="bar"><div class="fill" id="gMem" style="background:linear-gradient(90deg,#238636,#d29922,#f85149);width:0%"></div><div class="oom" style="left:100%"></div></div>
    <div class="lbl"><span id="gMemL">prod mem —</span><span>scale 0–640 MB</span></div></div>
  </div>
  <div class="panel quarter">
    <h3><span class="dot" id="dProd"></span>signer-prod</h3>
    <div class="kv"><span>release</span><span id="pVer" class="v-blue">—</span></div>
    <div class="kv"><span>leak</span><span id="pLeak">—</span></div>
    <div class="kv"><span>health</span><span id="pHealth">—</span></div>
    <div class="kv"><span>oom_risk</span><span id="pOom">—</span></div>
    <div class="kv"><span>uptime</span><span id="pUp">—</span></div>
    <div class="kv"><span>corrupted shards</span><span id="pShards">—</span></div>
    <div class="kv"><span>container RSS</span><span id="pRss">—</span></div>
  </div>

  <div class="panel third">
    <h3><span class="dot"></span>Traffic & SLO posture</h3>
    <canvas id="cRps" height="80"></canvas>
    <div class="kv"><span>rps / capacity</span><span id="sCap" class="v-blue">—</span></div>
    <div class="kv"><span>p99 latency</span><span id="sP99">—</span></div>
    <div class="kv"><span>SLO</span><span id="sSlo">—</span></div>
    <div class="kv"><span>headroom</span><span id="sHead">—</span></div>
  </div>
  <div class="panel third">
    <h3><span class="dot"></span>Infra & cost</h3>
    <div class="kv"><span>replicas</span><span id="iRep" class="v-blue">—</span></div>
    <div class="kv"><span>nodes</span><span id="iNodes">—</span></div>
    <div class="kv"><span>HPA max</span><span id="iHpa">—</span></div>
    <div class="kv"><span>cost / day</span><span id="iCost" class="v-yellow">—</span></div>
    <div class="kv"><span>pools</span><span id="iPools">—</span></div>
  </div>
  <div class="panel third">
    <h3><span class="dot"></span>Demo choreography <span style="text-transform:none;letter-spacing:0">(live admin API)</span></h3>
    <div class="ctrls">
      <button class="danger" onclick="ctl('deploy-leaky')">⬆ deploy v2.1.0 (leaky)</button>
      <button onclick="ctl('deploy-good')">⬇ rollback v1.42.0</button>
      <button class="danger" onclick="ctl('traffic-spike')">🔥 traffic 4200 rps</button>
      <button onclick="ctl('traffic-normal')">traffic 1000 rps</button>
      <button onclick="ctl('scale-up')">scale → 14</button>
      <button onclick="ctl('scale-down')">scale → 4</button>
    </div>
    <div class="m" style="color:var(--dim);font-size:10px;margin-top:8px">Same endpoints the agent's Surgeon calls — you're looking through the agent's eyes.</div>
  </div>

  <div class="panel half">
    <h3><span class="dot"></span>Runbook registry — compiled Execution Graphs</h3>
    <div id="runbooks"></div>
  </div>
  <div class="panel half">
    <h3><span class="dot" id="dGate2"></span>Immutable audit stream <span style="text-transform:none">(HMAC-chained JSONL)</span></h3>
    <div class="feed" id="audit"></div>
  </div>

  <div class="panel full">
    <h3><span class="dot"></span>Flywheel — every run commits the runbook smarter (the-stage repo)</h3>
    <div id="commits"></div>
  </div>
</div>

<footer>FIRERUN — act reversibly · rehearse before reality · no undo, no action — all data scraped live from the running system, nothing mocked</footer>

<script>
const $=id=>document.getElementById(id);
const fmtT=t=>new Date(t).toLocaleTimeString([], {hour12:false});
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function draw(id, defs, oomLine){
  const cv=$(id), dpr=devicePixelRatio||1, W=cv.clientWidth, H=cv.height;
  cv.width=W*dpr; const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  let mn=Infinity,mx=-Infinity;
  for(const d of defs) for(const p of d.data){mn=Math.min(mn,p.v);mx=Math.max(mx,p.v);}
  if(oomLine!=null){mn=Math.min(mn,0);mx=Math.max(mx,oomLine*1.08);}
  if(!isFinite(mn)){mn=0;mx=1;} if(mx-mn<1)mx=mn+1;
  const X=t=>{const ts=defs.flatMap(d=>d.data.map(p=>p.t));const t0=Math.min(...ts),t1=Math.max(...ts);return t1===t0?W:((t-t0)/(t1-t0))*(W-46)+42;};
  const Y=v=>H-8-((v-mn)/(mx-mn))*(H-20);
  ctx.strokeStyle='#1f2630';ctx.fillStyle='#8b949e';ctx.font='9px Menlo';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=8+i*(H-20)/4;ctx.beginPath();ctx.moveTo(40,y);ctx.lineTo(W,y);ctx.stroke();ctx.fillText(Math.round(mx-(mx-mn)*i/4),4,y+3);}
  if(oomLine!=null){ctx.strokeStyle='#f85149';ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(40,Y(oomLine));ctx.lineTo(W,Y(oomLine));ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#f85149';ctx.fillText(oomLine+' OOM',W-64,Y(oomLine)-4);}
  for(const d of defs){
    if(d.data.length<2)continue;
    ctx.beginPath();d.data.forEach((p,i)=>{const x=X(p.t),y=Y(p.v);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
    ctx.strokeStyle=d.color;ctx.lineWidth=1.6;ctx.stroke();
    if(d.fill){ctx.lineTo(X(d.data[d.data.length-1].t),H);ctx.lineTo(X(d.data[0].t),H);ctx.closePath();ctx.fillStyle=d.color+'22';ctx.fill();}
    const last=d.data[d.data.length-1];
    ctx.fillStyle=d.color;ctx.beginPath();ctx.arc(X(last.t),Y(last.v),2.6,0,7);ctx.fill();
  }
  ctx.fillStyle='#8b949e';
  for(const d of defs){if(!d.data.length)continue;ctx.fillStyle=d.color;ctx.fillText(d.name,W-92,10+defs.indexOf(d)*12);}
}

function ctl(action){fetch('/api/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})}).then(r=>r.text()).then(()=>refresh());}

const EVCLASS=e=>({gate_opened:'gate',gate_decision:'gate',run_halted:'gate',step_blocked_no_undo:'gate',rollback_card_forged:'good',addendum_committed:'good',addendum_written:'good',run_completed:'good'})[e]??'';
const EVCOL={gate_opened:'⛔',gate_decision:'🗝',run_halted:'🛑',step_blocked_no_undo:'⛔',rollback_card_forged:'🛠',rollback_card_authored:'🛠',addendum_committed:'📚',addendum_written:'📚',run_completed:'✅',run_started:'▶',tf_session_created:'👤',tf_turn_done:'💬',tool_call:'🔧',oncall_webhook:'Pager'};

async function refresh(){
  let s;
  try{ s=await (await fetch('/api/snapshot')).json(); }catch{ return; }
  $('clock').textContent=fmtT(s.now);

  // targets
  const tg=Object.fromEntries(s.targets.map(t=>[t.id,t]));
  const ok=t=>t&&t.lastOk&&Date.now()-t.lastOk<8000;
  const set=(id,txt,cls)=>{const e=$(id);e.textContent=txt;e.className='pill '+cls;};
  const p=tg.prod,tw=tg.twin,cl=tg.clB;
  set('hProd',ok(p)?\`PROD \${p.metrics?._version??p.state?.version??''} · \${Math.round(p.metrics?.app_mem_mb??0)}MB · leak=\${p.state?.leakOn}\`:'PROD — DOWN', ok(p)?(p.state?.leakOn?'bad':'ok'):'bad');
  set('hTwin',ok(tw)?\`TWIN \${Math.round(tw.metrics?.app_mem_mb??0)}MB · healthy\`:'TWIN — DOWN', ok(tw)?'ok':'bad');
  set('hCl',ok(cl)?\`CLUSTER-B · \${cl.state?.role??'standby'}\`:'CLUSTER-B — DOWN', ok(cl)?'info':'bad');
  $('dProd').className='dot '+(ok(p)?'':'down'); $('dMem').className='dot '+(ok(p)?'':'down'); $('dGate2').className='dot';

  // memory chart + gauge
  draw('cMem',[
    {name:'prod',color:'#f85149',fill:true,data:(s.series['prod:app_mem_mb']||[])},
    {name:'twin',color:'#3fb950',data:(s.series['twin:app_mem_mb']||[])},
    {name:'cl-b',color:'#58a6ff',data:(s.series['clB:app_mem_mb']||[])},
  ],512);
  const mem=p?.metrics?.app_mem_mb??0;
  $('gMem').style.width=Math.min(100,mem/640*100)+'%';
  $('gMemL').textContent=\`prod mem — \${Math.round(mem)} MB\`+(p?.metrics?.oom_risk?' · OOM RISK':'');
  $('pVer').textContent=p?.metrics?._version??'—'; $('pVer').className=(p?.metrics?._version==='v2.1.0')?'v-red':'v-blue';
  $('pLeak').innerHTML=p?.state?.leakOn?'<span class="v-red">● LEAKING</span>':'<span class="v-green">stable</span>';
  $('pHealth').textContent=p?.health?.marker??p?.health?.status??'—';
  $('pHealth').className=(p?.health?.marker==='mem_high')?'v-yellow':'v-green';
  $('pOom').textContent=p?.metrics?.oom_risk?'⚠ 1':'0';
  $('pOom').className=p?.metrics?.oom_risk?'v-red':'v-green';
  $('pUp').textContent=p?.health?.uptime_s!=null?Math.floor(p.health.uptime_s/60)+'m':'—';
  $('pShards').textContent=(s.shards ?? '—');
  const pRssV=(s.dockerMem ?? {})['prod-app'];
  const pRssEl=document.getElementById('pRss');
  if(pRssEl){pRssEl.textContent=pRssV!=null?pRssV+' MB (real)':'—';pRssEl.className=pRssV!=null&&pRssV>512?'v-red':'v-green';}

  // SLO / traffic
  draw('cRps',[
    {name:'rps',color:'#39d2c0',fill:true,data:(s.series['prod:app_rps']||[])},
    {name:'p99ms',color:'#d29922',data:(s.series['prod:p99_ms']||[])},
  ]);
  const slo=p?.slo;
  $('sCap').textContent=\`\${slo?.traffic_rps??'—'} / \${slo?.capacity_rps??'—'} rps\`;
  $('sP99').textContent=(p?.metrics?.p99_ms??'—')+' ms';
  $('sP99').className=(p?.metrics?.p99_ms??0)>150?'v-red':'v-green';
  $('sSlo').textContent=slo?.slo??'—'; $('sSlo').className=slo?.slo==='slo_ok'?'v-green':'v-red';
  $('sHead').textContent=slo?.headroom??'—'; $('sHead').className=slo?.headroom==='headroom_ok'?'v-green':'v-yellow';
  // infra
  $('iRep').textContent=p?.state?.replicas??'—';
  $('iNodes').textContent=p?.metrics?.nodes??'—';
  $('iHpa').textContent=p?.state?.hpa_max??'—';
  $('iCost').textContent='$'+(p?.metrics?.cost_usd_daily??'—')+'/day';
  $('iPools').textContent=(p?.state?.pools??[]).map(x=>\`\${x.name}:\${x.size}\`).join(' ');

  // runbooks
  $('runbooks').innerHTML=s.runbooks.map(r=>{
    const lr=r.lastRun;
    const st=lr?lr.steps.map(x=>\`\${x.status==='DONE'?'✅':x.status==='HALTED'?'🛑':x.status==='BLOCKED'?'⛔':'•'}\${x.id.replace('step-','')}\`).join(' '):'';
    const mode=lr?lr.mode:'';
    return \`<div class="rb"><div class="t">\${esc(r.title)}</div>
    <div class="m">📖 \${esc(r.file)} · rev \${esc(r.revision)} · \${r.steps} steps · \${r.gates} gate(s) · addenda: \${r.addenda} · runs: \${r.runCount}</div>
    <div>\${Object.entries(r.byType).map(([k,v])=>\`<span class="chip \${k}">\${k.replace('ACT_','ACT-')} ×\${v}</span>\`).join('')}</div>
    \${lr?\`<div class="m" style="margin-top:4px">\${mode==='REHEARSE'?'🧪 rehearsed':'🚀 executed'} \${lr.green?'<span class=v-green>GREEN</span>':'<span class=v-red>'+(lr.green===false?'halted':'…')+'</span>'} · \${fmtT(lr.startedAt)} · \${st}</div>\`:''}
    </div>\`;}).join('');

  // audit feed
  $('audit').innerHTML=s.audit.map(a=>{
    const e=a.event??'';
    const d=a.payload??{};
    const det=e==='gate_decision'?\`step \${d.step} → <b>\${d.decision}</b>\`
      :e==='gate_opened'?\`step \${d.step} — blast radius card up\`
      :e==='rollback_card_forged'||e==='rollback_card_authored'?\`\${(d.undo??'').slice(0,70)}\`
      :e==='addendum_committed'?esc(d.subject??d.commit??'runbook smarter')
      :e==='tool_call'?\`\${d.tool}: \${esc(JSON.stringify(d.args??{})).slice(0,80)}\`
      :e==='run_started'||e==='run_completed'||e==='run_halted'?\`\${esc(d.runbook??'').split('/').pop()} \${esc(d.mode??'')}\`
      :e==='tf_turn_done'?\`\${esc(d.role??'')} turn done\`
      :'';
    return \`<div class="ev \${EVCLASS(e)}"><span class="t">\${fmtT(a.ts)}</span><b>\${EVCOL[e]??'·'} \${esc(e)}</b> \${det}</div>\`;}).join('');

  // flywheel
  $('commits').innerHTML=s.commits.map(c=>\`<div class="commit"><span class="h">\${esc(c.hash)}</span> \${esc(c.subject)} <span class="w">\${esc(c.when)}</span></div>\`).join('')||'<div class=m>no commits yet — the flywheel lands here after the first live run</div>';

  // gate banner
  const g=s.gates&&s.gates.length?s.gates[s.gates.length-1]:null;
  $('gatebanner').style.display=g?'block':'none';
  if(g){$('gatedetail').innerHTML=\`<b>\${esc(g.step?.title??g.stepId??'step')}</b> — \${esc((g.willDo??'')).slice(0,200)}<br><span style="color:var(--dim)">undo: \${esc((g.rollbackCard?.undo??'—')).slice(0,140)} · confidence: \${esc(g.rollbackCard?.confidence??'—')}</span>\`;}
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
}

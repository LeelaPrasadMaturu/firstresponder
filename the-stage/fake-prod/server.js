// FAKE-PROD — the "real system" the runbooks act on.
// Deliberately realistic: real pages, real health/metrics endpoints, a
// choreographed memory leak, and a choreographed flaky page (broken render
// on the v2.2.0 release — the "exit code lies" demo moment).

const http = require('node:http');

const PORT = process.env.PORT || 8080;
let version = process.env.APP_VERSION || 'v1.42.0';
let leakOn = process.env.LEAK_ON === '1';
let statusFixed = false;
let ballast = [];           // the leak
const bootAt = Date.now();

// ── Infra model (scale / cost / cluster role — used by the infra runbooks) ──
let replicas = Number(process.env.REPLICAS ?? 10);
let hpaMax = Number(process.env.HPA_MAX ?? 20);
let trafficRps = Number(process.env.TRAFFIC_RPS ?? 400);
let role = process.env.CLUSTER_ROLE || 'primary';
const pools = [
  { name: 'core-pool', size: Number(process.env.CORE_POOL_SIZE ?? 4), rateUsdHr: 0.35 },
  { name: 'event-pool', size: Number(process.env.EVENT_POOL_SIZE ?? 0), rateUsdHr: 0.30 },
];

function capacityRps() {
  const eventPool = pools.find(p => p.name === 'event-pool');
  return replicas * 100 + (eventPool ? eventPool.size * 500 : 0);
}
function p99ms() { return Math.round(80 + Math.max(0, trafficRps - capacityRps()) / 20); }
function nodeCount() { return pools.reduce((a, p) => a + p.size, 0); }
function costUsdDaily() {
  return Math.round((pools.reduce((a, p) => a + p.size * p.rateUsdHr, 0) + replicas * 0.05) * 24 * 10) / 10;
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch { cb({}); } });
}

function memMb() {
  let base = process.memoryUsage().rss / 1024 / 1024;
  if (leakOn) base += ballast.length * 8; // +8MB per scrape while leaking
  return Math.round(base * 10) / 10;
}

const page = (title, body, status = 200) => `<!doctype html>
<html><head><title>${title}</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:3rem auto;padding:0 1rem;color:#1a1a2e}
nav a{margin-right:1rem} .ok{color:#0a7d33}.bad{color:#c0392b} .pill{background:#eef;padding:2px 10px;border-radius:99px}</style>
</head><body>
<nav><a href="/">home</a><a href="/pricing">pricing</a><a href="/status">status</a></nav>
<h1>${title}</h1>${body}
<p class="pill">release: ${version}</p>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/healthz') {
    const m = memMb();
    const ok = m < 512;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', version, mem_mb: m, uptime_s: Math.round((Date.now() - bootAt) / 1000), marker: ok ? 'mem_ok' : 'mem_high' }));
  }

  if (p === '/metrics') {
    if (leakOn) ballast.push(Buffer.alloc(8 * 1024 * 1024)); // the choreographed leak
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end([
      `# TYPE app_mem_mb gauge`, `app_mem_mb ${memMb()}`,
      `app_version{version="${version}"} 1`,
      `oom_risk ${memMb() > 400 ? 1 : 0}`,
      `p99_ms ${p99ms()}`,
      `app_rps ${trafficRps}`,
      `replicas ${replicas}`,
      `nodes ${nodeCount()}`,
      `cost_usd_daily ${costUsdDaily()}`,
    ].join('\n') + '\n');
  }

  // ── SLO posture — one endpoint the VERIFY probes can assert against ──────
  if (p === '/slo') {
    const cap = capacityRps();
    return json(res, 200, {
      p99_ms: p99ms(),
      capacity_rps: cap,
      traffic_rps: trafficRps,
      replicas,
      slo: p99ms() < 150 ? 'slo_ok' : 'slo_breach',
      headroom: trafficRps <= 0.8 * cap ? 'headroom_ok' : 'headroom_low',
      descale: trafficRps <= replicas * 30 ? 'descale_safe' : 'descale_unsafe',
    });
  }

  // ── Infra admin endpoints (the scale / downscale / move runbooks) ────────
  if (p === '/admin/scale' && req.method === 'POST') {
    return readBody(req, b => {
      const n = Number(b.replicas);
      if (!Number.isInteger(n) || n < 0 || n > 500) return json(res, 400, { error: 'replicas must be an integer 0..500' });
      replicas = n;
      json(res, 200, { replicas, capacity_rps: capacityRps(), p99_ms: p99ms() });
    });
  }
  if (p === '/admin/hpa' && req.method === 'POST') {
    return readBody(req, b => {
      const n = Number(b.max);
      if (!Number.isInteger(n) || n < 0 || n > 500) return json(res, 400, { error: 'max must be an integer 0..500' });
      hpaMax = n;
      json(res, 200, { hpaMax });
    });
  }
  if (p === '/admin/pools' && req.method === 'POST') {
    return readBody(req, b => {
      const pool = pools.find(x => x.name === b.name);
      const n = Number(b.size);
      if (!pool) return json(res, 404, { error: `unknown pool ${b.name}` });
      if (!Number.isInteger(n) || n < 0 || n > 100) return json(res, 400, { error: 'size must be an integer 0..100' });
      pool.size = n;
      json(res, 200, { pools: pools.map(x => ({ name: x.name, size: x.size })), nodes: nodeCount(), cost_usd_daily: costUsdDaily() });
    });
  }
  if (p === '/admin/traffic' && req.method === 'POST') {
    return readBody(req, b => {
      const n = Number(b.rps);
      if (!Number.isFinite(n) || n < 0) return json(res, 400, { error: 'rps must be >= 0' });
      trafficRps = Math.round(n);
      json(res, 200, { traffic_rps: trafficRps, p99_ms: p99ms() });
    });
  }
  if (p === '/admin/role' && req.method === 'POST') {
    return readBody(req, b => {
      if (!['primary', 'standby', 'decommissioned'].includes(b.role)) return json(res, 400, { error: 'role must be primary|standby|decommissioned' });
      role = b.role;
      json(res, 200, { role, note: 'simulated LB-weight flip / decommission flag' });
    });
  }

  if (p === '/admin/deploy' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const { version: v } = JSON.parse(body || '{}');
        if (!/^v\d+\.\d+\.\d+$/.test(v ?? '')) { res.writeHead(400); return res.end('bad version'); }
        version = v;
        leakOn = v === 'v2.1.0';           // only the bad release leaks
        if (v !== 'v2.2.0') statusFixed = statusFixed && false; // fix only persists for v2.2.0+
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ deployed: v, leakOn }));
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }

  if (p === '/admin/fix-status' && req.method === 'POST') {
    statusFixed = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ fixed: true, note: 'status page asset restored (reversible via /admin/unfix-status)' }));
  }
  if (p === '/admin/unfix-status' && req.method === 'POST') {
    statusFixed = false;
    res.writeHead(200);
    return res.end('{"fixed":false}');
  }
  if (p === '/admin/state') {
    return json(res, 200, {
      version, leakOn, statusFixed, mem_mb: memMb(),
      role, replicas, hpa_max: hpaMax, traffic_rps: trafficRps,
      p99_ms: p99ms(), capacity_rps: capacityRps(),
      nodes: nodeCount(), cost_usd_daily: costUsdDaily(),
      pools: pools.map(x => ({ name: x.name, size: x.size, rate_usd_hr: x.rateUsdHr })),
    });
  }

  if (p === '/') {
    return res.end(page('ACME Ops', `<p>Welcome to the ACME production system — the target of every runbook.</p>`));
  }
  if (p === '/pricing') {
    return res.end(page('Pricing', `<p>Plans start free. Enterprise: talk to sales.</p>`));
  }
  if (p === '/status') {
    // Choreographed flaky page: v2.2.0 shipped with a broken status widget —
    // the deploy "succeeds" (exit 0, healthz green) but the PAGE is broken.
    const broken = version === 'v2.2.0' && !statusFixed;
    const widget = broken
      ? `<div class="bad">__FIRERUN_BROKEN_PAGE__ status-widget failed to load (asset 404)</div>`
      : `<div class="ok">● All systems operational</div>`;
    return res.end(page('System Status', widget, 200));
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => console.log(`fake-prod ${version} listening on :${PORT} (leak=${leakOn})`));

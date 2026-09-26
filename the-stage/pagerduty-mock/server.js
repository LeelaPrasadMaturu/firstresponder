// PAGER MOCK — the 🔥 FIRE INCIDENT button.
// POSTs a PagerDuty-shaped webhook at the firerun gate server.

const http = require('node:http');

const PORT = process.env.PORT || 8090;
const GATE_URL = process.env.GATE_URL || 'http://host.docker.internal:7788';

const page = (msg = '') => `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Pager — ACME</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;max-width:520px;padding:2rem}
h1{font-size:1.75rem;font-weight:600;margin:0 0 .5rem}
.sub{color:#8b949e;margin:0 0 1.5rem;font-size:1rem}
button{font-size:1.25rem;padding:1rem 2.4rem;border-radius:14px;border:0;background:#b62324;color:#fff;cursor:pointer;font-weight:600}
button:hover{background:#da3633}
pre{background:#161b22;padding:1rem;border-radius:8px;max-width:600px;white-space:pre-wrap;margin-top:1.5rem;text-align:left;font-size:.9rem}</style></head>
<body><div class="card">
<h1>PagerDuty (mock)</h1>
<p class="sub">signer-prod &middot; memory pressure &middot; sev2</p>
<button onclick="fire()">FIRE INCIDENT</button>
<pre id="out">${msg}</pre>
</div>
<script>
async function fire(){
  const r = await fetch('${GATE_URL}/oncall', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({alert:'signer-prod memory pressure', severity:'sev2', service:'signer-prod', fired_at:new Date().toISOString()})});
  document.getElementById('out').textContent = r.ok ? '✅ page sent — the agent is on it' : '❌ ' + r.status + ' — is firerun serve running?';
}
</script></body></html>`;

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page());
}).listen(PORT, () => console.log(`pager mock on :${PORT} → ${GATE_URL}/oncall`));

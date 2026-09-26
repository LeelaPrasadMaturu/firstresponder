// PAGER MOCK — the 🔥 FIRE INCIDENT button.
// POSTs a PagerDuty-shaped webhook at the firerun gate server.

const http = require('node:http');

const PORT = process.env.PORT || 8090;
const GATE_URL = process.env.GATE_URL || 'http://host.docker.internal:7788';

const page = (msg = '') => `<!doctype html>
<html><head><title>Pager — ACME</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
button{font-size:1.4rem;padding:1rem 2.4rem;border-radius:14px;border:0;background:#b62324;color:#fff;cursor:pointer}
pre{background:#161b22;padding:1rem;border-radius:8px;max-width:600px;white-space:pre-wrap}</style></head>
<body><div style="text-align:center">
<h1>📟 PagerDuty (mock)</h1>
<p>signer-prod · memory pressure · sev2</p>
<button onclick="fire()">🔥 FIRE INCIDENT</button>
<pre id="out">${msg}</pre>
</div>
<script>
async function fire(){
  const r = await fetch('${GATE_URL}/oncall', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({alert:'signer-prod memory pressure', severity:'sev2', service:'signer-prod', fired_at:new Date().toISOString()})});
  document.getElementById('out').textContent = r.ok ? '✅ page sent — the agent is on it' : '❌ ' + r.status + ' — is firerun serve running?';
}
</script></body></html>`;

http.createServer((req, res) => res.end(page())).listen(PORT, () => console.log(`pager mock on :${PORT} → ${GATE_URL}/oncall`));

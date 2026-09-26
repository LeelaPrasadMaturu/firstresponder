import fs from 'node:fs';
import path from 'node:path';

// Tiny .env loader — no dependency, keeps the engine friction-free.
export function loadEnv(file = '.env'): void {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// Load .env BEFORE building the config object — ESM imports evaluate before
// cli.ts's own loadEnv() call would run, so the config must be lazy-proof.
loadEnv();

export const config = {
  apiKey: process.env.OPENAI_API_KEY ?? '',
  baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
  model: process.env.OPENAI_MODEL ?? 'gpt-4o',

  // ── Gateway adapters ──
  // Portkey: https://api.portkey.ai/v1 + x-portkey-* headers.
  //   PORTKEY_VIRTUAL_KEY replaces the provider key entirely (recommended).
  //   PORTKEY_PROVIDER is only needed when passing a raw provider key through.
  portkeyApiKey: process.env.PORTKEY_API_KEY ?? '',
  portkeyVirtualKey: process.env.PORTKEY_VIRTUAL_KEY ?? '',
  portkeyProvider: process.env.PORTKEY_PROVIDER ?? '',
  // TrueFoundry AI Gateway: OpenAI-compatible at https://gateway.truefoundry.ai
  //   (or your control-plane URL) — auth flows through OPENAI_API_KEY.
  provider: (process.env.FIRERUN_PROVIDER ?? 'openai') as 'openai' | 'portkey' | 'truefoundry' | 'ollama',

  // Slack approval-card notifications (incoming webhook)
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
  prodAppUrl: process.env.PROD_APP_URL ?? 'http://localhost:8080',
  twinAppUrl: process.env.TWIN_APP_URL ?? 'http://localhost:8081',
  clusterBAppUrl: process.env.CLUSTER_B_APP_URL ?? 'http://localhost:18082',
  prodDbUrl: process.env.PROD_DB_URL ?? 'postgres://stage:stage@localhost:5433/stagedb',
  twinDbUrl: process.env.TWIN_DB_URL ?? 'postgres://stage:stage@localhost:5434/stagedb',

  gatePort: Number(process.env.GATE_PORT ?? 7788),
  gateMode: (process.env.FIRERUN_GATE ?? 'http') as 'cli' | 'http' | 'auto',
  gateTimeoutMin: Number(process.env.GATE_TIMEOUT_MIN ?? 15),

  sandboxDir: path.resolve(process.env.FIRERUN_SANDBOX_DIR ?? '.firerun/sandbox'),
  execTimeoutMs: Number(process.env.FIRERUN_EXEC_TIMEOUT_MS ?? 30000),
  runsDir: path.resolve('.firerun/runs'),
  auditFile: path.resolve('.firerun/AUDIT.jsonl'),
  auditKey: process.env.FIRERUN_AUDIT_KEY ?? 'dev-key-change-me',
};

export function ensureDirs(): void {
  fs.mkdirSync(config.sandboxDir, { recursive: true });
  fs.mkdirSync(config.runsDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.auditFile), { recursive: true });
}

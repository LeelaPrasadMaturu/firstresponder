/**
 * FIRSTRESPONDER Stage tools — exposed as a Streamable-HTTP MCP server.
 *
 * This is how the agent's hands plug into TrueForge (this TF version supports
 * remote MCP servers only, so stdio is not an option). Registered in TF
 * Settings → MCP servers, then attached per-role with `enable_tools`:
 *   Scout/Verifier agents  → read tools only
 *   Surgeon agent          → read + write tools (write tools are gated via
 *                            require_approval_for_tools in the agent spec)
 *
 * The credential fork is enforced at THREE layers:
 *   1. TF agent spec (enable_tools)  — the model never sees write tools
 *   2. MCP annotations               — read tools are marked readOnlyHint
 *   3. This server                   — db read tool REJECTS non-SELECT in code
 *
 * NOTE: one McpServer instance may connect only ONE transport, so this server
 * creates a fresh McpServer per session (SDK session-mode pattern).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { loadEnv, config } from '../config.js';

// Load firerun/.env so the MCP server targets the same Stage as the CLI
// (defaults match .env.example; overrides land here automatically).
loadEnv();

const PROD_APP_URL = process.env.PROD_APP_URL ?? 'http://localhost:8080';
const TWIN_APP_URL = process.env.TWIN_APP_URL ?? 'http://localhost:8081';
const PROD_DB_URL = process.env.PROD_DB_URL ?? 'postgres://stage:stage@localhost:5433/stagedb';
const TWIN_DB_URL = process.env.TWIN_DB_URL ?? 'postgres://stage:stage@localhost:5434/stagedb';
const SANDBOX_DIR = process.env.FIRERUN_SANDBOX_DIR ?? '.firerun/sandbox';
const EXEC_TIMEOUT_MS = Number(process.env.FIRERUN_EXEC_TIMEOUT_MS ?? 30000);

const SELECT_RE = /^\s*(select|with|explain|show)\b/i;

async function dbRun(dbUrl: string, sql: string): Promise<unknown> {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const r = await c.query(sql);
    return { rowCount: r.rowCount ?? 0, rows: r.rows.slice(0, 50) };
  } finally {
    await c.end();
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'firerun-stage', version: '0.2.0' });

  // ── READ tools (readOnlyHint: true — TF runs these autonomously) ──────────

  server.registerTool(
    'stage_http_probe',
    {
      title: 'Stage HTTP probe',
      description: 'Make an HTTP request against the Stage services. PASS A PATH like /healthz or /pricing (resolves against the target app), or a full http://localhost:8080/... URL. Do NOT invent hostnames.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        url: z.string().describe('absolute http(s) URL, or a path like /healthz (goes to the current target app)'),
        method: z.enum(['GET', 'POST']).optional(),
        body: z.string().optional(),
      },
    },
    async ({ url, method, body }: { url: string; method?: 'GET' | 'POST'; body?: string }) => {
      // Steer common model mistakes: "http://app/..." or bare "app/..." → target app
      const normalized = url.replace(/^https?:\/\/app(?=\/)/, '').replace(/^app(?=\/)/, '');
      const abs = /^https?:\/\//.test(normalized) ? normalized : new URL(normalized, PROD_APP_URL).toString();
      const res = await fetch(abs, {
        method: method ?? 'GET',
        body: method === 'POST' ? body : undefined,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      return { content: [{ type: 'text', text: JSON.stringify({ status: res.status, body: text.slice(0, 2000) }) }] };
    },
  );

  server.registerTool(
    'stage_db_read',
    {
      title: 'Stage DB read',
      description: 'Run a READ-ONLY SQL query (SELECT/WITH/EXPLAIN) on the Stage database. Writes are rejected by the runtime.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        sql: z.string().describe('a SELECT/WITH/EXPLAIN statement'),
        target: z.enum(['prod', 'twin']).optional().describe('which database; default prod'),
      },
    },
    async ({ sql, target }: { sql: string; target?: 'prod' | 'twin' }) => {
      if (!SELECT_RE.test(sql)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'WRITE REJECTED: read tool only accepts SELECT/WITH/EXPLAIN' }) }] };
      }
      const dbUrl = target === 'twin' ? TWIN_DB_URL : PROD_DB_URL;
      return { content: [{ type: 'text', text: JSON.stringify(await dbRun(dbUrl, sql)) }] };
    },
  );

  server.registerTool(
    'stage_file_read',
    {
      title: 'Stage file read',
      description: 'Read a file (logs, runbook, config). No path traversal.',
      annotations: { readOnlyHint: true },
      inputSchema: { path: z.string() },
    },
    async ({ path }: { path: string }) => {
      if (path.includes('..')) throw new Error('path traversal rejected');
      const fs = await import('node:fs');
      return { content: [{ type: 'text', text: fs.readFileSync(path, 'utf8').slice(0, 4000) }] };
    },
  );

  // ── WRITE tools (gated: require_approval_for_tools in the TF agent spec) ──

  server.registerTool(
    'stage_db_write',
    {
      title: 'Stage DB write',
      description: 'Run a mutating SQL statement (INSERT/UPDATE/DELETE/DDL) on the Stage database. GATED: requires human approval.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        sql: z.string().describe('a mutating SQL statement'),
        target: z.enum(['prod', 'twin']).optional().describe('which database; default prod'),
      },
    },
    async ({ sql, target }: { sql: string; target?: 'prod' | 'twin' }) => {
      const dbUrl = target === 'twin' ? TWIN_DB_URL : PROD_DB_URL;
      return { content: [{ type: 'text', text: JSON.stringify(await dbRun(dbUrl, sql)) }] };
    },
  );

  server.registerTool(
    'stage_exec',
    {
      title: 'Stage sandbox exec',
      description: 'Run a shell command in the sandbox working directory (hard timeout, output capped). Use for scripts, psql via docker exec, curl, file processing. GATED: requires human approval.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        command: z.string(),
        timeoutMs: z.number().optional(),
      },
    },
    async ({ command, timeoutMs }: { command: string; timeoutMs?: number }) => {
      const { execFileSync } = await import('node:child_process');
      const fs = await import('node:fs');
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });
      try {
        const out = execFileSync('bash', ['-c', command], {
          cwd: SANDBOX_DIR,
          timeout: Math.min(timeoutMs ?? EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS),
          encoding: 'utf8',
          maxBuffer: 1024 * 512,
          env: { ...process.env },
        });
        return { content: [{ type: 'text', text: JSON.stringify({ exitCode: 0, stdout: out.slice(0, 3000) }) }] };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { content: [{ type: 'text', text: JSON.stringify({ exitCode: e.status ?? 1, stdout: (e.stdout ?? '').slice(0, 1500), stderr: (e.stderr ?? '').slice(0, 1500) }) }] };
      }
    },
  );

  server.registerTool(
    'stage_report',
    {
      title: 'Stage report',
      description: 'Report a finding or completion back to the orchestrator.',
      annotations: { readOnlyHint: true },
      inputSchema: { finding: z.string() },
    },
    async ({ finding }: { finding: string }) => ({ content: [{ type: 'text', text: `acknowledged: ${finding.slice(0, 500)}` }] }),
  );

  return server;
}

// ── Streamable-HTTP wiring (STATEFUL — TF sends initialize then calls with
//    an mcp-session-id header; transports must survive across requests) ─────

const app = express();
app.use(express.json({ limit: '4mb' }));

const transports = new Map<string, StreamableHTTPServerTransport>();

async function createTransport(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => globalThis.crypto.randomUUID(),
    enableJsonResponse: true,
  });
  transport.onclose = () => {
    const id = [...transports.entries()].find(([, t]) => t === transport)?.[0];
    if (id) transports.delete(id);
  };
  await createMcpServer().connect(transport);
  return transport;
}

app.post('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const transport = sid && transports.has(sid) ? transports.get(sid)! : await createTransport();
    await transport.handleRequest(req, res, req.body);
    if (transport.sessionId && !transports.has(transport.sessionId)) transports.set(transport.sessionId, transport);
  } catch (err) {
    console.error('[firerun-stage-mcp] POST /mcp error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' } });
  }
});

app.get('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  const transport = sid ? transports.get(sid) : undefined;
  if (!transport) { res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown session (no SSE stream)' } }); return; }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  const transport = sid ? transports.get(sid) : undefined;
  if (!transport) { res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unknown session' } }); return; }
  await transport.handleRequest(req, res);
  transports.delete(sid!);
});

// Never let a bad request kill the process
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[firerun-stage-mcp] middleware error:', err);
  if (!res.headersSent) res.status(400).json({ error: 'bad request' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, tools: 6 }));

const PORT = Number(process.env.FIRERUN_MCP_PORT ?? 7789);
const listener = app.listen(PORT, () => {
  console.error(`[firerun-stage-mcp] Streamable HTTP MCP server on http://localhost:${PORT}/mcp`);
});
listener.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[firerun-stage-mcp] port ${PORT} already in use — an instance is probably already running. If it's stale: lsof -ti :${PORT} | xargs kill`);
    process.exit(1);
  }
  throw err;
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from './config.js';

/**
 * TOOL REGISTRY — the agent's hands.
 *
 * Two scopes (the credential fork, enforced HERE in code, not by prompting):
 *   readonly scope  → db_query rejects everything except SELECT/WITH/EXPLAIN.
 *   readwrite scope → full access, but the orchestrator only grants it to the
 *                     Surgeon subagent, and only for the current run.
 *
 * The LLM never chooses its own scope — the orchestrator does.
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
}

export interface ToolContext {
  runId: string;
  role: 'SCOUT' | 'SURGEON' | 'VERIFIER';
  allowedTools: string[];
  /** app + db endpoints this role may touch (target forking) */
  appUrl: string;
  dbUrl: string;
  /** Surgeon gets readwrite */
  readwrite: boolean;
}

// ─── Tool implementations ────────────────────────────────────────────────────

async function httpFetch(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 2000) };
}

let Client: typeof import('pg').Client | null = null;
async function dbQuery(dbUrl: string, sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
  if (!Client) { const pg = await import('pg'); Client = pg.default.Client; }
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query(sql);
    return { rows: res.rows.slice(0, 50), rowCount: res.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

const SELECT_RE = /^\s*(select|with|explain|show)\b/i;

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  if (!ctx.allowedTools.includes(name)) throw new Error(`tool ${name} not permitted for role ${ctx.role}`);
  if (tool.readOnly && !ctx.readwrite && requiresWrite(name, args)) {
    throw new Error(`WRITE REJECTED: role ${ctx.role} is read-only (credential fork enforced at tool layer)`);
  }

  switch (name) {
    case 'http_probe': {
      const url = String(args.url ?? '');
      if (!url.startsWith('http')) throw new Error('http_probe requires an absolute http(s) url');
      return httpFetch(url, args.method ? { method: String(args.method), body: args.body ? String(args.body) : undefined } : undefined);
    }
    case 'db_query': {
      const sql = String(args.sql ?? '');
      if (!ctx.readwrite && !SELECT_RE.test(sql)) {
        throw new Error(`WRITE REJECTED: read-only role attempted: ${sql.slice(0, 80)}`);
      }
      return dbQuery(ctx.dbUrl, sql);
    }
    case 'exec': {
      // Sandboxed: fixed cwd, hard timeout, output capped, command recorded.
      ensureDirs();
      const cmd = String(args.command ?? '');
      const timeoutMs = Math.min(Number(args.timeoutMs ?? config.execTimeoutMs), config.execTimeoutMs);
      try {
        const out = execFileSync('bash', ['-c', cmd], {
          cwd: config.sandboxDir,
          timeout: timeoutMs,
          encoding: 'utf8',
          maxBuffer: 1024 * 512,
          env: {
            ...process.env,
            FIRERUN_ROLE: ctx.role,
            // endpoints the runbook commands may address ($-expanded by bash)
            APP_URL: ctx.appUrl,
            DATABASE_URL: ctx.dbUrl,
            PROD_APP_URL: config.prodAppUrl,
            PROD_DB_URL: config.prodDbUrl,
            TWIN_APP_URL: config.twinAppUrl,
            TWIN_DB_URL: config.twinDbUrl,
            CLUSTER_B_APP_URL: config.clusterBAppUrl,
          },
        });
        return { exitCode: 0, stdout: out.slice(0, 3000) };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: e.status ?? 1, stdout: (e.stdout ?? '').slice(0, 1500), stderr: (e.stderr ?? '').slice(0, 1500) };
      }
    }
    case 'read_file': {
      const p = String(args.path ?? '');
      if (p.includes('..')) throw new Error('path traversal rejected');
      return { content: fs.readFileSync(p, 'utf8').slice(0, 4000) };
    }
    case 'write_file': {
      if (!ctx.readwrite) throw new Error('write_file requires readwrite scope');
      const p = path.resolve(String(args.path ?? ''));
      if (!p.startsWith(config.sandboxDir) && !p.startsWith(process.cwd())) throw new Error('write outside sandbox/workdir rejected');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(args.content ?? ''));
      return { written: p };
    }
    case 'report': {
      return { acknowledged: true };
    }
    default:
      throw new Error(`unimplemented tool: ${name}`);
  }
}

function requiresWrite(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'db_query') return !SELECT_RE.test(String(args.sql ?? ''));
  if (toolName === 'write_file') return true;
  if (toolName === 'exec') return true; // exec can write; treat as privileged
  return false;
}

// ─── Tool definitions (function-calling schema) ──────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: 'http_probe',
    description: 'Make an HTTP request to a service endpoint and observe status + body. Use to check health, pages, APIs.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'absolute http(s) URL' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        body: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'db_query',
    description: 'Run SQL against the database. Read-only roles may only run SELECT/WITH/EXPLAIN — writes are rejected by the runtime.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
    },
  },
  {
    name: 'exec',
    description: 'Run a shell command in the sandbox (fixed working dir, hard timeout). Use for scripts, psql dumps, file processing. Prefer http_probe/db_query for observations.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file (logs, configs). No path traversal.',
    readOnly: true,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write a file inside the sandbox or workdir (surgeon only).',
    readOnly: false,
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'report',
    description: 'Report a finding or completion to the orchestrator.',
    readOnly: true,
    parameters: { type: 'object', properties: { finding: { type: 'string' } }, required: ['finding'] },
  },
];

// ─── Role factories (the credential fork) ────────────────────────────────────

export function makeScout(ctx: { runId: string; appUrl: string; dbUrl: string }): ToolContext {
  return {
    runId: ctx.runId, role: 'SCOUT', appUrl: ctx.appUrl, dbUrl: ctx.dbUrl, readwrite: false,
    allowedTools: ['http_probe', 'db_query', 'read_file', 'report'],
  };
}

export function makeSurgeon(ctx: { runId: string; appUrl: string; dbUrl: string }): ToolContext {
  return {
    runId: ctx.runId, role: 'SURGEON', appUrl: ctx.appUrl, dbUrl: ctx.dbUrl, readwrite: true,
    allowedTools: ['http_probe', 'db_query', 'exec', 'read_file', 'write_file', 'report'],
  };
}

export function makeVerifier(ctx: { runId: string; appUrl: string; dbUrl: string }): ToolContext {
  return {
    runId: ctx.runId, role: 'VERIFIER', appUrl: ctx.appUrl, dbUrl: ctx.dbUrl, readwrite: false,
    allowedTools: ['http_probe', 'db_query', 'exec', 'read_file', 'report'], // exec read-only usage policed by audit
  };
}

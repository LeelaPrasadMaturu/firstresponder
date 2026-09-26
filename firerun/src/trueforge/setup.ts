/**
 * FIRSTRESPONDER × TrueForge — one-time setup (idempotent).
 *
 *   npm run tf:mcp    # terminal 1: Stage tools as a Streamable-HTTP MCP server
 *   npm run tf:setup  # terminal 2: register provider + MCP server + 3 role agents
 *
 * Everything is configured programmatically from firerun/.env — the same
 * three provider presets (OpenAI direct / Portkey / TrueFoundry Gateway)
 * work here as in the builtin runtime, because TrueForge accepts any
 * OpenAI-compatible endpoint as a "custom" provider.
 *
 * The credential fork lives in the AGENT MANIFEST:
 *   - Scout/Verifier: enable_tools = read tools only
 *   - Surgeon: read + write tools, require_approval_for_tools names the gated
 *     ones — the human-checkpoint pause is enforced by the HARNESS itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, config, ensureDirs } from '../config.js';

loadEnv();

const TF = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const here = path.dirname(fileURLToPath(import.meta.url));
const GATED_TOOLS = ['stage_db_write', 'stage_exec'];
const READ_TOOLS = ['stage_http_probe', 'stage_db_read', 'stage_file_read', 'stage_report'];
const WRITE_TOOLS = [...READ_TOOLS, ...GATED_TOOLS];

// ─── Model provider manifest (from the same presets as the builtin runtime) ──

function providerManifest(): { manifest: Record<string, unknown>; qualified: string } {
  const modelId = (config.model ?? 'gpt-4o').replace(/^\w+\//, ''); // upstream id sent to the provider (e.g. FW-GLM-5.3-Flash)
  // TF model `name` must be a ResourceName: 2-64 lowercase chars
  const modelName = modelId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'model';

  if (config.provider === 'portkey') {
    const key = config.portkeyVirtualKey || config.portkeyApiKey || config.apiKey;
    if (!key) throw new Error('Portkey preset selected but no key configured (.env)');
    console.log('   provider: custom "portkey" → https://api.portkey.ai/v1');
    if (!config.portkeyVirtualKey) {
      console.log('   ⚠️  No PORTKEY_VIRTUAL_KEY set — Portkey needs the x-portkey-api-key header.');
      console.log('      If turns 401, create a Virtual Key in the Portkey dashboard and set PORTKEY_VIRTUAL_KEY.');
    }
    return {
      manifest: {
        type: 'custom', name: 'portkey', base_url: 'https://api.portkey.ai/v1',
        auth: { api_key: key },
        models: [{ model_id: modelId, name: modelName, properties: { context_length: 128000, max_output_tokens: 8192 } }],
      },
      qualified: `portkey/${modelName}`,
    };
  }
  if (config.provider === 'truefoundry') {
    if (!config.apiKey) throw new Error('TrueFoundry preset selected but OPENAI_API_KEY (TF key) missing');
    console.log(`   provider: custom "truefoundry" → ${config.baseUrl}`);
    return {
      manifest: {
        type: 'custom', name: 'truefoundry', base_url: config.baseUrl,
        auth: { api_key: config.apiKey },
        models: [{ model_id: modelId, name: modelName, properties: { context_length: 128000, max_output_tokens: 8192 } }],
      },
      qualified: `truefoundry/${modelName}`,
    };
  }
  if (config.provider === 'ollama') {
    console.log(`   provider: custom "ollama" → ${config.baseUrl}`);
    return {
      manifest: {
        type: 'custom', name: 'ollama', base_url: config.baseUrl,
        models: [{ model_id: modelId, name: modelName, properties: { context_length: 128000, max_output_tokens: 8192 } }],
      },
      qualified: `ollama/${modelName}`,
    };
  }
  // openai direct
  if (!config.apiKey) throw new Error('OpenAI preset selected but OPENAI_API_KEY missing');
  console.log('   provider: openai → https://api.openai.com/v1');
  return {
    manifest: {
      type: 'openai',
      auth: { api_key: config.apiKey },
      models: [{ model_id: modelId, name: modelName, properties: { context_length: 128000, max_output_tokens: 8192 } }],
    },
    qualified: `openai/${modelName}`,
  };
}

// ─── Role agent manifests (the credential fork + harness-level gates) ────────

function roleAgent(role: 'SCOUT' | 'ANALYST' | 'SURGEON' | 'EXECUTOR' | 'VERIFIER' | 'SCRIBE', qualifiedModel: string) {
  const instructions: Record<string, string> = {
    SCOUT: `You are SCOUT, a read-only triage subagent of the FIRSTRESPONDER runbook runtime.
You are FIRST on scene for an incident: assess service health, memory, traffic and the release
currently deployed. You have NO write tools — it is physically impossible for you to change the world.
Be fast and precise; cite what you observed (probe outputs, query results). End findings with a one-line CONCLUSION.`,
    ANALYST: `You are ANALYST, a read-only root-cause subagent of the FIRSTRESPONDER runbook runtime.
SCOUT triaged the incident; your job is the deep dig: query the database, follow the retry storm,
confirm or refute the suspected root cause with EVIDENCE. You have NO write tools — read-only, always.
When the runbook step contains conditional (if/else) logic, evaluate the condition against the live
system and state explicitly which branch you took and why. End with ROOT CAUSE: <one line>.`,
    SURGEON: `You are SURGEON, the reversible-remediation subagent of the FIRSTRESPONDER runbook runtime.
You perform exactly the step you are given — nothing more. Write tools pause for human approval (enforced by the harness).
IMPORTANT: perform ALL Stage operations (HTTP probes, database access, docker exec, curl) exclusively through your stage_* MCP tools — they run on the host with docker and network access to the Stage. Do NOT use your code sandbox to reach the Stage; it has neither docker nor access to localhost services.
Every action you take was already given a validated rollback card by the Rollback Forge — execute cleanly.
If reality deviates from what the runbook expects, STOP and report HALT with evidence instead of improvising.
When the runbook step contains conditional (if/else) logic, evaluate the condition against live state,
take the matching branch, and say which branch you took. When the step is complete, summarize what you changed and end with DONE.`,
    EXECUTOR: `You are EXECUTOR, the gated irreversible-action subagent of the FIRSTRESPONDER runbook runtime.
You only run steps that CANNOT be undone automatically. The human gate has ALREADY approved this exact
action with a blast-radius card and an undo plan — execute it exactly as written, nothing more.
IMPORTANT: perform ALL Stage operations exclusively through your stage_* MCP tools.
If the precondition stated in the step is not true, STOP and report HALT with evidence.
When done, report exactly what changed and end with DONE.`,
    VERIFIER: `You are VERIFIER, an independent read-only verification subagent of the FIRSTRESPONDER runbook runtime.
You verify postconditions by OBSERVING the world yourself (probes, read-only SQL) — never by trusting another agent's claims.
If the postcondition holds, reply DONE. Otherwise reply FAILED: <evidence>.`,
    SCRIBE: `You are SCRIBE, the incident-record subagent of the FIRSTRESPONDER runbook runtime.
You read the audit trail, run transcripts and probes to compose factual incident records and runbook
addenda: what happened, what was decided, by whom, and what the next run should know.
You have NO write tools — you produce text, the runtime commits it. Never invent facts; quote evidence.`,
  };
  const tools: Record<string, string[]> = {
    SCOUT: READ_TOOLS,
    ANALYST: READ_TOOLS,
    SURGEON: WRITE_TOOLS,
    EXECUTOR: WRITE_TOOLS,
    VERIFIER: READ_TOOLS,
    SCRIBE: READ_TOOLS,
  };
  const gated: Record<string, string[]> = { SURGEON: GATED_TOOLS, EXECUTOR: GATED_TOOLS };
  // Daytona sandbox: the runtime's "doubt → verify" roles get a real cloud sandbox
  // (TrueForge resolves the provider from the sandbox-provider store = Daytona).
  // Isolation bonus: the sandbox cannot reach the Stage — it's pure compute + evidence.
  const wantsDaytonaSandbox = role === 'ANALYST' || role === 'SCRIBE';
  return {
    name: `firerun-${role.toLowerCase()}`,
    description: `FIRSTRESPONDER ${role} — runbook runtime role`,
    manifest: {
      model: { name: qualifiedModel },
      instructions: instructions[role],
      mcp_servers: [{
        name: 'firerun-stage',
        enable_tools: tools[role],
        require_approval_for_tools: gated[role] ?? [],
      }],
      config: {
        iteration_limit: 20,
        ...(wantsDaytonaSandbox ? { sandbox: { enabled: true, file_downloads: false } } : {}),
      },
    },
  };
}

async function api(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${TF}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

async function main(): Promise<void> {
  // 1. Model provider (from our presets)
  const { manifest: providerManifestBody, qualified } = providerManifest();
  const prov = await api('PUT', '/settings/model-providers', { manifest: providerManifestBody });
  if (!prov.ok) throw new Error(`model provider PUT ${prov.status}: ${JSON.stringify(prov.json).slice(0, 300)}`);
  console.log(`✅ model provider registered → agents will use ${qualified}`);

  // 2. Stage MCP server
  const mcpPort = Number(process.env.FIRERUN_MCP_PORT ?? 7789);
  const mcp = await api('PUT', '/settings/mcp-servers', {
    manifest: {
      type: 'remote', name: 'firerun-stage',
      url: `http://localhost:${mcpPort}/mcp`,
      description: 'FIRSTRESPONDER Stage tools: HTTP probes, read-only SQL, gated SQL writes, sandbox exec.',
    },
  });
  if (!mcp.ok) throw new Error(`MCP server PUT ${mcp.status}: ${JSON.stringify(mcp.json).slice(0, 300)}`);
  console.log(`✅ MCP server 'firerun-stage' registered (${GATED_TOOLS.length} gated tools)`);

  // 3. Six role agents (idempotent) — the on-call team
  for (const role of ['SCOUT', 'ANALYST', 'SURGEON', 'EXECUTOR', 'VERIFIER', 'SCRIBE'] as const) {
    const agent = roleAgent(role, qualified);
    const list = await api('GET', `/agents?agent_name=${agent.name}`);
    const existing = (list.json?.data ?? []).find((a: { name: string }) => a.name === agent.name);
    if (existing) {
      const upd = await api('PUT', `/agents/${existing.id}`, { description: agent.description, manifest: agent.manifest });
      if (!upd.ok) throw new Error(`agent update ${agent.name}: ${upd.status} ${JSON.stringify(upd.json).slice(0, 200)}`);
      console.log(`✅ agent updated: ${agent.name} (tools: ${agent.manifest.mcp_servers[0].enable_tools.length}, gated: ${agent.manifest.mcp_servers[0].require_approval_for_tools.length})`);
    } else {
      const created = await api('POST', '/agents', agent);
      if (!created.ok) throw new Error(`agent create ${agent.name}: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
      console.log(`✅ agent created: ${agent.name} (tools: ${agent.manifest.mcp_servers[0].enable_tools.length}, gated: ${agent.manifest.mcp_servers[0].require_approval_for_tools.length})`);
    }
  }

  // 4. Nightly monitoring sweep — TF Schedules runs the read-only agent unattended.
  //    Demo point: 'the 01:00 sweep nobody wants' as a first-class TF schedule.
  const sched = await api('POST', '/schedules', {
    agent_name: 'firerun-verifier',
    name: 'nightly-infra-monitor-sweep',
    manifest: {
      task: `Run the nightly infra monitoring sweep (runbook: infra-monitor.md, read-only).
Steps: probe GET /admin/state, GET /healthz (expect mem_ok), content-check / and /pricing and /status (expect ACME / Plans / operational),
then stage_db_read: SELECT count(*) FROM orders (must be >0) and SELECT count(*) FROM cache_shards WHERE corrupted (must be 0).
Finish with a one-paragraph report: release, memory, page-surface status, row-count trend, shard health. End with CONCLUSION: <one line>.`,
      cron: '0 1 * * *',
      timezone: 'Asia/Kolkata',
      status: 'active',
    },
  });
  if (sched.ok) console.log('✅ schedule registered: nightly-infra-monitor-sweep (01:00 IST, firerun-verifier)');
  else console.log(`⚠️  schedule: ${sched.status} ${JSON.stringify(sched.json).slice(0, 150)}`);

  // 5. Marker for the orchestrator
  ensureDirs();
  fs.writeFileSync(path.join(config.runsDir, 'tf-setup.json'), JSON.stringify({ at: new Date().toISOString(), model: qualified, gated: GATED_TOOLS }, null, 2));
  console.log(`\n🎯 TrueForge setup complete — server at ${TF}, chat UI in your browser, SDK-driven by firerun.`);
}

main().catch(err => {
  console.error('💥 setup failed:', err?.message ?? err);
  process.exit(1);
});

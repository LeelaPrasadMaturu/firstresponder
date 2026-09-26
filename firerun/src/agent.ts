import { config } from './config.js';
import { appendAudit } from './audit.js';
import { TOOLS, type ToolContext, executeTool, makeScout } from './tools.js';

/**
 * THE AGENT LOOP.
 *
 * This is agentic, not "an LLM call":
 *  - The model is given a TOOLBOX and a GOAL, never a script.
 *  - Each turn it chooses which tool to call with which arguments.
 *  - The tool's observation is fed back; the loop continues until the model
 *    reports DONE (or a circuit breaker fires).
 *  - Every tool call executes REAL effects (HTTP, SQL, shell in sandbox) —
 *    the model plans and decides; the runtime executes and records.
 *
 * OpenAI-compatible function calling is the transport, so any provider works
 * (OpenAI / TrueFoundry AI Gateway / Ollama / LiteLLM) by pointing OPENAI_BASE_URL.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface LoopResult {
  done: boolean;
  reason: string;
  transcript: Array<{ role: string; content: string; toolCalls?: unknown[] }>;
  iterations: number;
}

export async function chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatMessage> {
  // Provider adapters — OpenAI-compatible transport for all of them.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.provider === 'portkey') {
    if (config.portkeyApiKey) headers['x-portkey-api-key'] = config.portkeyApiKey;
    if (config.portkeyVirtualKey) {
      headers['x-portkey-virtual-key'] = config.portkeyVirtualKey;
    } else if (config.apiKey) {
      headers['authorization'] = `Bearer ${config.apiKey}`; // raw provider key passthrough
    }
    if (config.portkeyProvider) headers['x-portkey-provider'] = config.portkeyProvider;
  } else if (config.apiKey) {
    // openai / truefoundry gateway / anything bearer-based
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
}

/**
 * Run the agentic loop for one goal.
 * The model drives; tools act; observations loop back.
 */
export async function runAgentLoop(opts: {
  goal: string;
  system: string;
  ctx: ToolContext;
  maxIterations?: number;
  onToolCall?: (name: string, args: unknown, result: unknown) => void;
  transcript?: LoopResult['transcript'];
}): Promise<LoopResult> {
  const { goal, system, ctx, onToolCall } = opts;
  const maxIterations = opts.maxIterations ?? 14;
  const transcript = opts.transcript ?? [];

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: goal },
  ];

  const toolDefs = TOOLS.filter(t => ctx.allowedTools.includes(t.name)).map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  for (let i = 0; i < maxIterations; i++) {
    const msg = await chat(messages, toolDefs);
    transcript.push({ role: msg.role, content: msg.content ?? '', toolCalls: msg.tool_calls });

    if (!msg.tool_calls?.length) {
      // The model responded in prose — treat non-"DONE" prose as its report.
      const saysDone = /DONE/i.test(msg.content ?? '');
      return { done: saysDone, reason: msg.content ?? '(no content)', transcript, iterations: i + 1 };
    }

    messages.push(msg);
    for (const tc of msg.tool_calls) {
      let args: unknown = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      let result: unknown;
      try {
        result = await executeTool(tc.function.name, args as Record<string, unknown>, ctx);
      } catch (err) {
        result = { error: String(err instanceof Error ? err.message : err) };
      }
      onToolCall?.(tc.function.name, args, result);
      appendAudit('tool_call', { tool: tc.function.name, args, result: summarize(result) }, ctx.runId);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 4000),
      });
    }
  }

  return { done: false, reason: `circuit breaker: exceeded ${maxIterations} agentic iterations`, transcript, iterations: maxIterations };
}

function summarize(result: unknown): unknown {
  const s = JSON.stringify(result);
  if (!s || s.length <= 300) return result;
  // Never JSON.parse a truncated string — return a safe preview object instead.
  return { truncated: true, bytes: s.length, preview: s.slice(0, 300) };
}

/**
 * Agentic step classification: the model inspects the step's text (and may
 * run read-only tools) and proposes a type. The COMPILER enforces the
 * fail-safe: any UNKNOWN or invalid answer becomes ACT_IRREVERSIBLE.
 */
export async function classifyStepWithAgent(title: string, body: string): Promise<import('./types.js').StepType> {
  try {
    const scoutCtx = makeScout({ runId: 'compiler', appUrl: config.prodAppUrl, dbUrl: config.prodDbUrl });
    const loop = await runAgentLoop({
      system: `You classify runbook steps for an agent-execution runtime. Types:
- READ: only observes (fetch status, query SELECT, read logs/metrics).
- ACT_REVERSIBLE: changes state but a safe, tested undo is possible (re-deploy previous version, create resources, restore-from-snapshot patterns).
- ACT_IRREVERSIBLE: deletes data, applies schema changes to prod, sends external communication, rotates credentials — anything that cannot be cleanly undone.
- VERIFY: asserts a postcondition (probes, diffs, checks).
Think briefly, optionally inspect state with tools, then end your final message with exactly one line: TYPE: <TYPE>.`,
      goal: `Classify this runbook step:\nTitle: ${title}\nBody: ${body.slice(0, 1200)}`,
      ctx: scoutCtx,
      maxIterations: 5,
      transcript: [],
    });
    const m = (loop.reason ?? '').match(/TYPE:\s*(READ|ACT_REVERSIBLE|ACT_IRREVERSIBLE|VERIFY|UNKNOWN)/i);
    return (m?.[1]?.toUpperCase() ?? 'UNKNOWN') as import('./types.js').StepType;
  } catch {
    return 'UNKNOWN'; // fail-safe
  }
}

/**
 * Structured-output ask with validation retry (used by classification and
 * the Rollback Forge). Still agentic: the model may call tools to inspect
 * the world before answering.
 */
export async function askStructured<T>(opts: {
  system: string;
  user: string;
  schemaHint: string;
  validate: (obj: unknown) => T | null;   // return parsed value or null to retry
  ctx: ToolContext;
  retries?: number;
}): Promise<T> {
  const retries = opts.retries ?? 2;
  let messages: ChatMessage[] = [
    { role: 'system', content: `${opts.system}\n\nYou may use your tools to inspect the world before answering. When ready, reply with ONLY a JSON object, no prose.` },
    { role: 'user', content: `${opts.user}\n\nReply with ONLY a JSON object matching:\n${opts.schemaHint}` },
  ];
  for (let i = 0; i <= retries; i++) {
    const msg = await runAgentLoop({
      goal: messages[1].content!,
      system: messages[0].content!,
      ctx: opts.ctx,
      maxIterations: 6,
      transcript: [],
    });
    const jsonMatch = (msg.reason ?? '').match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const valid = opts.validate(parsed);
        if (valid !== null) return valid;
      } catch { /* fall through to retry */ }
    }
    messages = [
      messages[0],
      { role: 'user', content: `${opts.user}\n\nYour previous answer was invalid. Reply with ONLY a valid JSON object matching:\n${opts.schemaHint}` },
    ];
  }
  throw new Error('askStructured: model failed to produce valid JSON after retries');
}

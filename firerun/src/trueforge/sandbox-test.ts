/** Sandbox-as-tool test: Surgeon writes+runs code in the Daytona sandbox. */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { loadEnv } from '../config.js';
loadEnv();
const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790', timeoutInSeconds: 180 });
const { data: session } = await client.sessions.create({ agent: { name: 'firerun-surgeon' } } as never);
console.log('session:', session.id);
try {
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: 'Use your sandbox (code mode): write a small Node script into the sandbox that prints the current UTC time and the result of 6*7, run it, and report the output. End with DONE.' }],
  } as never);
  for await (const { data: event } of (stream as any).withMetadata()) {
    const e = event as any;
    if (e.type === 'thread.created') console.log('  ↳ subagent:', e.title);
    if (e.type === 'tool.response') console.log('  🔧 tool:', (e as any).name ?? '');
    if (e.type === 'turn.done') { console.log('  turn.done:', e.state?.status); console.log('  output:', (e.state?.output?.content ?? '').slice(0, 300)); break; }
  }
} catch (err: any) { console.log('⚠️', String(err?.message ?? err).slice(0, 250)); }

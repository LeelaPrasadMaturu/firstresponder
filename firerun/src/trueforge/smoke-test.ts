/**
 * Smoke test: full TrueForge chain — session on firerun-scout, one turn,
 * tool call through our MCP server. Run: npm run tf:smoke
 *
 * Requires a working model provider in TF (Settings → Models). Without a
 * valid key this fails at the model call — which is still proof that
 * sessions/turns/MCP wiring work.
 */
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { loadEnv } from '../config.js';

loadEnv();

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790', timeoutInSeconds: 120 });

const { data: session } = await client.sessions.create({ agent: { name: 'firerun-scout' } } as never);
console.log('✅ session created:', session.id);

try {
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: 'Use stage_http_probe to check GET /healthz on the app, then use stage_report with your finding. End with CONCLUSION: <one line>.' }],
  } as never);

  for await (const { data: event } of (stream as { withMetadata: () => AsyncIterable<Record<string, unknown>> }).withMetadata()) {
    const e = event as { type: string; content?: string; state?: { status?: string; output?: { content?: string } } };
    if (e.type === 'tool.response') console.log('  🔧 tool executed via TrueForge');
    if (e.type === 'model.message.delta' && e.content) process.stdout.write(e.content);
    if (e.type === 'turn.done') {
      console.log(`\n✅ turn.done — status: ${e.state?.status}`);
      console.log('  output:', (e.state?.output?.content ?? '').slice(0, 400));
      break;
    }
  }
} catch (err) {
  console.log('\n⚠️  turn failed (expected without a working model provider):');
  console.log('  ', String((err as Error).message ?? err).slice(0, 300));
  console.log('   → configure the model in TF (npm run tf:setup does this from .env; check PORTKEY_VIRTUAL_KEY)');
  process.exit(2);
}

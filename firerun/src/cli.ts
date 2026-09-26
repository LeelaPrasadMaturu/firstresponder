#!/usr/bin/env node
import fs from 'node:fs';
import { loadEnv, config, ensureDirs } from './config.js';
import { compileRunbook } from './compiler.js';
import { executeGraph } from './orchestrator.js';
import { executeGraphTF, isRehearsed as isRehearsedTF } from './tf-orchestrator.js';
import { isRehearsed as isRehearsedBuiltin } from './orchestrator.js';

// RUNTIME: 'trueforge' is the compliant path (the agent loop runs inside the
// TrueForge harness). 'builtin' is a local fallback for tool-less testing.
const RUNTIME = (process.env.FIRERUN_RUNTIME ?? 'trueforge') as 'trueforge' | 'builtin';
const runGraph = (g: Parameters<typeof executeGraph>[0], m: 'REHEARSE' | 'EXECUTE') =>
  RUNTIME === 'trueforge' ? executeGraphTF(g, m) : executeGraph(g, m);
import { startGateServer } from './gate.js';
import { writeAddendum } from './flywheel.js';
import { verifyChain, readAll } from './audit.js';

loadEnv();
ensureDirs();

const [, , cmd, ...rest] = process.argv;
const fileArg = rest.find(a => !a.startsWith('--'));
const flags = new Set(rest.filter(a => a.startsWith('--')));

function die(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function header(): void {
  console.log(`
  ─────────────────────────────────────────────
  🩹 FIRSTRESPONDER — the runbook runtime
  no undo, no action · rehearse before reality
  ─────────────────────────────────────────────`);
}

/**
 * Full on-call flow: rehearse against the twin if this graph version was
 * never rehearsed (the rehearsal-prerequisite invariant, satisfied not
 * skipped), then execute live, then flywheel the addendum.
 */
async function runOnCall(runbookPath: string): Promise<void> {
  const graph = await compileRunbook(runbookPath);
  const r = RUNTIME === 'trueforge' ? isRehearsedTF(graph) : isRehearsedBuiltin(graph);
  if (!r.green) {
    console.log('  🎭 No green rehearsal for this graph — shadow-running against the twin first...');
    const rehearsal = await runGraph(graph, 'REHEARSE');
    if (!rehearsal.green) {
      console.log('  🛑 Rehearsal FAILED — refusing to execute live. Fix the runbook first.');
      return;
    }
  }
  const state = await runGraph(graph, 'EXECUTE');
  if (state.green) await writeAddendum(state);
}

function checkModelConfig(): void {
  const ok =
    (config.provider === 'portkey' && (!!config.portkeyApiKey || !!config.portkeyVirtualKey || !!config.apiKey)) ||
    (config.provider !== 'portkey' && !!config.apiKey);
  if (!ok) {
    die(`Model provider not fully configured (provider=${config.provider}).
   · Portkey: set PORTKEY_API_KEY + (PORTKEY_VIRTUAL_KEY or OPENAI_API_KEY)
     → create a Virtual Key in the Portkey dashboard (Virtual Keys → OpenAI).
   · TrueFoundry Gateway: set OPENAI_BASE_URL=https://gateway.truefoundry.ai
     + OPENAI_API_KEY + exact OPENAI_MODEL id (see docs/ai-gateway/quick-start).
   · OpenAI direct: set OPENAI_API_KEY.
   See firerun/.env.example for all three presets.`);
  }
}

async function main(): Promise<void> {
  header();

  switch (cmd) {
    case 'compile': {
      if (!fileArg) die('usage: npm run cli -- compile <runbook.md>');
      const graph = await compileRunbook(fileArg);
      const out = fileArg.replace(/\.md$/, '.graph.json');
      fs.writeFileSync(out, JSON.stringify(graph, null, 2));
      console.log(`\n📐 Compiled ${graph.steps.length} steps → ${out}\n`);
      for (const s of graph.steps) {
        const icon = s.type === 'READ' ? '🔍' : s.type === 'VERIFY' ? '✅' : s.type === 'ACT_REVERSIBLE' ? '🔧' : '⛔';
        console.log(`  ${icon} ${s.id} [${s.type}${s.classifiedBy === 'fail-safe' ? '!' : ''}] ${s.title}${s.gate ? '  ← GATE' : ''}`);
      }
      console.log(`\n  (!) = fail-safe classification (no marker) — treated as irreversible by design.`);
      break;
    }

    case 'rehearse': {
      if (!fileArg) die('usage: npm run cli -- rehearse <runbook.md>');
      checkModelConfig();
      const graph = await compileRunbook(fileArg);
      const state = await runGraph(graph, 'REHEARSE');
      if (state.green) console.log('\n🎯 Safe to execute. Run: npm run cli -- execute ' + fileArg);
      else process.exit(2);
      break;
    }

    case 'execute': {
      if (!fileArg) die('usage: npm run cli -- execute <runbook.md>');
      checkModelConfig();
      const graph = await compileRunbook(fileArg);
      const r = RUNTIME === 'trueforge' ? isRehearsedTF(graph) : isRehearsedBuiltin(graph);
      if (!r.green) {
        die(`INVARIANT: no green rehearsal for this graph version (${r.detail}).\n   Run:  npm run cli -- rehearse ${fileArg}\n   (This is the rehearsal-prerequisite invariant — it cannot be skipped, only satisfied.)`);
      }
      if (config.gateMode === 'http' && !flags.has('--no-serve')) startGateServer();
      console.log('  (gate server starting — approve from browser or phone)\n');
      await new Promise(res => setTimeout(res, 800));
      const state = await runGraph(graph, 'EXECUTE');
      if (state.green) await writeAddendum(state);
      else process.exit(2);
      break;
    }

    case 'oncall': {
      if (!fileArg) die('usage: npm run cli -- oncall <incident-runbook.md>');
      checkModelConfig();
      const alertFile = '.firerun/oncall-alert.json';
      const alert = fs.existsSync(alertFile) ? JSON.parse(fs.readFileSync(alertFile, 'utf8')) : null;
      console.log(`\n🚨 ON-CALL MODE${alert ? ` — alert received ${alert.receivedAt}` : ' — manual trigger'}\n`);
      await runOnCall(fileArg);
      break;
    }

    case 'serve': {
      // serve [runbook.md] → gate UI + webhook listener; with a runbook arg,
      // an incoming alert (Opsgenie/PagerDuty/slack/pager-mock) auto-triggers
      // the full on-call flow: rehearse-if-needed → execute → flywheel.
      startGateServer();
      if (fileArg) {
        checkModelConfig();
        console.log(`  🚨 Auto-on-call armed: an alert will run ${fileArg}
  Waiting for alerts… (press 🔥 at the pager mock: http://localhost:8090, or fire from Opsgenie)
`);
        let running = false;
        setInterval(() => {
          if (running || !fs.existsSync('.firerun/oncall-alert.json')) return;
          fs.rmSync('.firerun/oncall-alert.json');
          running = true;
          runOnCall(fileArg)
            .catch(err => console.error('💥 on-call run failed:', err))
            .finally(() => { running = false; });
        }, 2000);
      } else {
        console.log('  Waiting for alerts… (press 🔥 at the pager mock: http://localhost:8090)\n');
        setInterval(() => {
          if (fs.existsSync('.firerun/oncall-alert.json')) {
            console.log('  🚨 Alert detected! Run: npm run cli -- serve the-stage/runbooks/incident-memory-leak.md  (or: oncall <runbook>)');
          }
        }, 3000);
      }
      break;
    }

    case 'audit': {
      const chain = verifyChain();
      const records = readAll();
      console.log(`\n📜 Audit trail: ${records.length} records — chain ${chain.ok ? '✅ VERIFIED (HMAC chain intact)' : `❌ BROKEN at seq ${chain.brokenAt}`}\n`);
      for (const r of records.slice(-15)) {
            console.log(`  ${r.ts}  ${r.event.padEnd(24)} ${JSON.stringify(r.payload).slice(0, 100)}`);
      }
      break;
    }

    default:
      console.log(`
  Usage: npm run cli -- <command>

  compile  <runbook.md>      markdown → Execution Graph (deterministic)
  rehearse <runbook.md>      full dry-run against the staging twin
  execute  <runbook.md>      live run (gates + flywheel)
  oncall   <runbook.md>      incident mode (consume webhook alert)
  serve                      gate UI + pager webhook listener
  audit                      show + verify the HMAC audit chain

  Demo flow:
    cd the-stage && docker compose up -d
    npm run cli -- rehearse ../the-stage/runbooks/incident-memory-leak.md
    npm run cli -- execute  ../the-stage/runbooks/incident-memory-leak.md
`);
  }
}

main().catch(err => {
  console.error('\n💥', err);
  process.exit(1);
});

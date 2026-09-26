import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import type { AuditRecord } from './types.js';

/**
 * HMAC-chained append-only audit log.
 * Every record includes the hash of the previous one — tampering is detectable.
 * This is the "receipts" layer: every agent decision leaves a trace.
 */
export function appendAudit(event: string, payload: Record<string, unknown> = {}, runId?: string): AuditRecord {
  const records = readAll();
  const prev = records.at(-1);
  const rec: AuditRecord = {
    seq: (prev?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    runId,
    event,
    payload,
    prevHash: prev?.hash ?? 'GENESIS',
    hash: '',
  };
  const canonical = JSON.stringify({ seq: rec.seq, ts: rec.ts, runId: rec.runId, event: rec.event, payload: rec.payload, prevHash: rec.prevHash });
  rec.hash = crypto.createHmac('sha256', config.auditKey).update(canonical).digest('hex');
  fs.appendFileSync(config.auditFile, JSON.stringify(rec) + '\n');
  return rec;
}

export function readAll(): AuditRecord[] {
  if (!fs.existsSync(config.auditFile)) return [];
  return fs.readFileSync(config.auditFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as AuditRecord);
}

export function verifyChain(): { ok: boolean; brokenAt?: number } {
  const records = readAll();
  for (const rec of records) {
    const canonical = JSON.stringify({ seq: rec.seq, ts: rec.ts, runId: rec.runId, event: rec.event, payload: rec.payload, prevHash: rec.prevHash });
    const expect = crypto.createHmac('sha256', config.auditKey).update(canonical).digest('hex');
    if (rec.hash !== expect) return { ok: false, brokenAt: rec.seq };
  }
  return { ok: true };
}

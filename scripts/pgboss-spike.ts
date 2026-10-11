import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

const connectionString = z.string().min(1).parse(process.env.PG_BOSS_SPIKE_URL);
const schema = `studio_boss_spike_${randomUUID().replaceAll('-', '')}`;
const boss = new PgBoss({ connectionString, schema, max: 2, application_name: 'studio-isolated-queue-spike', supervise: false, schedule: false });
const results: Record<string, boolean> = {};
try {
  await boss.start(); results.installation = true;
  await boss.createQueue('dead'); await boss.createQueue('work', { retryLimit: 0, deadLetter: 'dead', heartbeatSeconds: 10 });
  const database = boss.getDb(); const transaction = await database.beginTransaction?.();
  assert.ok(transaction, 'The database adapter must supply a session-pinned transaction.');
  const rolledBack = await boss.send('work', { eventId: randomUUID() }, { db: transaction.db }); assert.ok(rolledBack); await transaction.rollback();
  assert.equal(await boss.getJobById('work', rolledBack), null); results.transactionRollback = true;
  const committed = await database.beginTransaction?.(); assert.ok(committed);
  await committed.db.executeSql(`create table if not exists ${schema}.outbox(event_id text primary key,job_id uuid)`);
  const eventId = randomUUID(); const id = await boss.send('work', { eventId }, { db: committed.db }); assert.ok(id);
  await committed.db.executeSql(`insert into ${schema}.outbox(event_id,job_id) values($1,$2)`, [eventId, id]); await committed.commit();
  assert.equal((await database.executeSql(`select job_id from ${schema}.outbox where event_id=$1`, [eventId])).rows.length, 1); results.atomicOutbox = true;
  const [claim] = await boss.fetch('work', { includeMetadata: true }); assert.ok(claim); assert.equal(claim.id, id);
  await boss.touch('work', { id, retryCount: claim.retryCount }); assert.ok((await boss.getJobById('work', id))?.heartbeatOn); results.heartbeat = true;
  await boss.cancel('work', { id, retryCount: claim.retryCount });
  await boss.complete('work', { id, retryCount: claim.retryCount }); assert.equal((await boss.getJobById('work', id))?.state, 'cancelled'); results.cancelLateCompletionFence = true;
  const delayed = await boss.sendAfter('work', { delay: true }, null, 30); assert.ok(delayed); assert.equal((await boss.fetch('work')).length, 0); await boss.cancel('work', delayed); results.delayed = true;
  const failed = await boss.send('work', { failure: true }); assert.ok(failed); const [attempt] = await boss.fetch('work', { includeMetadata: true }); assert.ok(attempt); await boss.fail('work', attempt);
  const dead = await boss.fetch('dead'); assert.equal(dead.length, 1); results.deadLetter = true;
  await boss.complete('dead', dead[0]?.id ?? '');
  const retried = await boss.send('work', { recover: true }); assert.ok(retried); const [old] = await boss.fetch('work', { includeMetadata: true }); assert.ok(old); await boss.fail('work', old); await boss.retry('work', retried); const [fresh] = await boss.fetch('work', { includeMetadata: true }); assert.ok(fresh);
  await boss.complete('work', old); assert.equal((await boss.getJobById('work', fresh.id))?.state, 'active'); await boss.complete('work', fresh); results.oldAttemptFence = true;
  // Live consumers continue pgmq until process-kill/network/outbox-drainer deployment and minimum-role proofs pass.
  console.log(JSON.stringify({ spike: results, engine: 'pgmq', scheduler: 'pg_cron', cutover: false, remainingGate: ['process-kill and network-fault transactional drainer recovery', 'minimum-role schema bootstrap and runtime grants', 'paused business-state drain and single-engine cutover'] }));
} catch (error) {
  console.log(JSON.stringify({ spike: results, engine: 'pgmq', cutover: false, failure: error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[redacted connection]') : 'Queue spike failed.' }));
  process.exitCode = 1;
} finally {
  try { await boss.getDb().executeSql(`drop schema if exists ${schema} cascade`); } catch { /* Isolated schema remains for inspection if database unavailable. */ }
  await boss.stop({ graceful: false }).catch(() => undefined); await delay(10);
}

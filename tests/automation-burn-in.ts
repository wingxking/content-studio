// Repeated isolated acceptance, never a product schedule owner or a live publisher.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';

await loadRuntimeEnvironment();

if (!process.argv.includes('--confirm-isolated-burn-in')) throw new Error('Use --confirm-isolated-burn-in.');
if (new URL(process.env.SUPABASE_URL ?? '').hostname !== 'kong') throw new Error('Burn-in requires the existing local Docker Supabase network.');
const hours = Number(process.env.STUDIO_BURN_IN_HOURS ?? 48);
const interval = Number(process.env.STUDIO_BURN_IN_INTERVAL_MS ?? 1800000);
if (!Number.isFinite(hours) || hours < 0.01 || hours > 48 || !Number.isFinite(interval) || interval < 60000) throw new Error('Use a duration up to 48 hours and interval of at least one minute.');
const started = Date.now(); let checks = 0; let stopping = false; const controller = new AbortController();
const stop = () => { stopping = true; controller.abort(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log(JSON.stringify({ burnIn: 'started', startedAt: new Date(started).toISOString(), targetHours: hours }));
while (!stopping && Date.now() - started < hours * 3600000) {
  const iterationStarted = Date.now();
  for (const [file, flag] of [['tests/ecosystem-docker-smoke.ts', ''], ['tests/automation-restart-smoke.ts', '--confirm-isolated-database']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', file!, ...(flag ? [flag] : [])], { stdio: 'inherit', env: process.env });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Isolated acceptance failed: ${file}`)));
    });
  }
  if (Date.now() - iterationStarted > 120000) throw new Error('Acceptance iteration was interrupted or exceeded two minutes; restart the burn-in window.');
  checks++; console.log(JSON.stringify({ burnIn: 'running', checks, elapsedHours: (Date.now() - started) / 3600000, targetHours: hours, realExternalPublications: 0 }));
  const completedAt = Date.now(); const sleepTime = Math.max(0, Math.min(interval, hours * 3600000 - (completedAt - started)));
  await delay(sleepTime, undefined, { signal: controller.signal }).catch(error => { if (!controller.signal.aborted) throw error; });
  if (!stopping && Date.now() - completedAt > sleepTime + 120000) throw new Error('Burn-in was interrupted by sleep, clock drift or a stalled runtime; restart the window.');
}
console.log(JSON.stringify({ burnIn: stopping ? 'stopped' : 'passed', checks, elapsedHours: (Date.now() - started) / 3600000, targetHours: hours }));

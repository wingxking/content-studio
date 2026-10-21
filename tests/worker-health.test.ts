import test from 'node:test';
import assert from 'node:assert/strict';
import { closeProcessHealth, createProcessHealth, listenProcessHealth } from '../src/server/process-health.ts';

test('worker readiness belongs to the live process and becomes unavailable during shutdown', async () => {
  const health = createProcessHealth(); await listenProcessHealth(health.server, 0);
  const address = health.server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${origin}/readyz`)).status, 503);
    health.ready(); assert.equal((await fetch(`${origin}/readyz`)).status, 200);
    health.stopping(); assert.equal((await fetch(`${origin}/readyz`)).status, 503);
    assert.equal((await fetch(`${origin}/other`)).status, 404);
  } finally { await closeProcessHealth(health.server); }
  await assert.rejects(fetch(`${origin}/healthz`));
});

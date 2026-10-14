import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { executionResultSchema, verifiedExecutionStatus } from '../src/core/execution-contract.ts';
import { accountExecutionKey, withAccountExecution } from '../src/core/account-execution.ts';
import type { Account } from '../src/core/model.ts';
const account = (id = randomUUID()): Account => ({ id, platform: 'youtube', provider: 'native', integrationId: 'UCphysical', label: 'Test', status: 'connected', note: '', verifiedAt: null });
test('execution acceptance never counts as verified publication, and account/processing/visibility must match', () => {
  const expected = { platform: 'xueqiu', accountId: '123', visibility: 'public' as const }; const attemptId = randomUUID();
  assert.equal(verifiedExecutionStatus({ version: 1, status: 'accepted', attemptId }, expected), 'queued');
  const result = executionResultSchema.parse({ version: 1, status: 'verified', attemptId, remote: { id: '456', url: 'https://xueqiu.com/123/456', account: { platform: 'xueqiu', accountId: '123' }, processing: 'ready', visibility: 'public' } });
  assert.equal(verifiedExecutionStatus(result, expected), 'published');
  if (result.status === 'verified') assert.equal(verifiedExecutionStatus({ ...result, remote: { ...result.remote, url: 'https://fixture.invalid/123/456' } }, expected), 'needs_reconciliation');
  assert.equal(verifiedExecutionStatus(result, { ...expected, accountId: 'other' }), 'needs_reconciliation');
  assert.throws(() => executionResultSchema.parse({ ...result, version: 2 }));
  assert.throws(() => executionResultSchema.parse({ version: 1, status: 'rejected', noSideEffect: false, error: { code: 'ERR', stage: 'receipt', retryable: true, message: 'No response' } }));
});
test('same remote account receives one execution key even after local rebinding', async () => {
  const first = account(); const second = account(); assert.equal(accountExecutionKey(first), accountExecutionKey(second));
  const jobId = randomUUID(); let release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; }); let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const running = withAccountExecution(first, jobId, 'write', async () => { entered?.(); await blocked; });
  await started; await assert.rejects(withAccountExecution(second, randomUUID(), 'metrics', async () => undefined), /busy/);
  release?.(); await running;
  await withAccountExecution(second, randomUUID(), 'metrics', async () => undefined);
});
test('verified physical identity serializes native and provider bindings without trusting display names', () => {
 const physicalIdentity = { id: 'actual-remote-uid', verification: 'api' as const, verifiedAt: new Date().toISOString() };
 const native = { ...account(), platform: 'x' as const, physicalIdentity };
 const provider = { ...native, id: randomUUID(), provider: 'postiz' as const, integrationId: 'different-provider-route', label: 'Different display label' };
 assert.equal(accountExecutionKey(native), accountExecutionKey(provider));
 assert.notEqual(accountExecutionKey(native), accountExecutionKey({ ...native, physicalIdentity: { ...physicalIdentity, id: 'different-remote-uid' } }));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { accountSchema, jobSchema, type Account, type Variant } from '../src/core/model.ts';
import { RejectedPublishError, savePostizDraft, submitPostiz, UncertainPublishError, type Integration } from '../src/core/postiz.ts';

type RecordedRequest = { method: string | undefined; url: string | undefined; authorization: string | undefined; body: unknown };
const date = '2026-10-13T00:00:00.000Z';
const account = (): Account => accountSchema.parse({ id: randomUUID(), platform: 'x', provider: 'postiz', label: 'Fixture X account', integrationId: 'integration-x', status: 'connected', note: '', verifiedAt: date });
const variant = (): Variant => ({ platform: 'x', title: 'Reviewed article', text: 'Reviewed content.', tags: ['draft'], mediaPaths: [] });
const integration = (): Integration => ({ id: 'integration-x', identifier: 'x', name: 'Fixture X account', disabled: false });
const job = (target: Account) => jobSchema.parse({ id: randomUUID(), draftId: randomUUID(), platform: target.platform, accountId: target.id, approvedHash: 'approved-fixture', status: 'awaiting_operator', scheduledAt: date, createdAt: date, provider: 'postiz', remoteId: null, remoteUrl: null, attempts: 0, error: null, submissionStartedAt: date, history: [] });

async function withProvider(respond: (response: ServerResponse) => void, run: (requests: RecordedRequest[]) => Promise<void>): Promise<void> {
  const requests: RecordedRequest[] = [];
  const previousKey = process.env.POSTIZ_API_KEY;
  const previousBase = process.env.POSTIZ_BASE_URL;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      respond(response);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    process.env.POSTIZ_API_KEY = 'fixture-not-a-real-key';
    process.env.POSTIZ_BASE_URL = `http://127.0.0.1:${address.port}/public/v1`;
    await run(requests);
  } finally {
    if (previousKey === undefined) delete process.env.POSTIZ_API_KEY; else process.env.POSTIZ_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.POSTIZ_BASE_URL; else process.env.POSTIZ_BASE_URL = previousBase;
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}
function receipt(response: ServerResponse): void {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify([{ postId: 'postiz-draft-123', integration: 'integration-x' }]));
}

test('saving a Postiz draft sends only one explicit draft request and returns a provider-only identifier', async () => {
  await withProvider(receipt, async requests => {
    const target = account(); const publication = job(target); const before = structuredClone(publication);
    assert.equal(await savePostizDraft(publication, target, variant(), integration()), 'postiz-draft-123');
    assert.deepEqual(requests, [{ method: 'POST', url: '/public/v1/posts', authorization: 'fixture-not-a-real-key', body: {
      type: 'draft', date, shortLink: false, tags: [], posts: [{ integration: { id: 'integration-x' }, value: [{ content: 'Reviewed content.\n\n#draft', image: [] }], settings: { __type: 'x', who_can_reply_post: 'everyone' } }],
    } }]);
    assert.deepEqual(publication, before);
    assert.equal(publication.remoteId, null); assert.equal(publication.remoteUrl, null);
  });
});

test('existing Postiz submission remains an immediate publish request', async () => {
  await withProvider(receipt, async requests => {
    const target = account();
    assert.equal(await submitPostiz(job(target), target, variant(), integration()), 'postiz-draft-123');
    assert.equal(requests.length, 1);
    assert.equal((requests[0]?.body as { type: string }).type, 'now');
  });
});

test('draft staging rejects mismatched accounts, disabled integrations, media and invalid text before sending', async () => {
  await withProvider(receipt, async requests => {
    const target = account(); const publication = job(target);
    for (const invalid of [{ ...integration(), id: 'another-account' }, { ...integration(), identifier: 'linkedin' }, { ...integration(), disabled: true }]) {
      await assert.rejects(savePostizDraft(publication, target, variant(), invalid), /match the selected/);
    }
    await assert.rejects(savePostizDraft(publication, target, { ...variant(), platform: 'reddit' }, integration()), /match the selected/);
    await assert.rejects(savePostizDraft(publication, target, { ...variant(), mediaPaths: ['/private/image.png'] }, integration()), /media upload is not configured/);
    await assert.rejects(savePostizDraft(publication, target, { ...variant(), text: 'A'.repeat(300) }, integration()), /280/);
    const reddit = { ...target, platform: 'reddit' as const };
    await assert.rejects(savePostizDraft(job(reddit), reddit, { ...variant(), platform: 'reddit' }, { ...integration(), identifier: 'reddit' }), /explicit subreddit/);
    assert.equal(requests.length, 0);
  });
});

test('draft requests preserve rejected versus unknown outcomes and never retry automatically', async t => {
  const scenarios: { name: string; respond: (response: ServerResponse) => void; error: typeof RejectedPublishError | typeof UncertainPublishError }[] = [
    { name: 'validation rejection', respond: response => { response.statusCode = 400; response.end(); }, error: RejectedPublishError },
    { name: 'authentication rejection', respond: response => { response.statusCode = 401; response.end(); }, error: RejectedPublishError },
    { name: 'request timeout', respond: response => { response.statusCode = 408; response.end(); }, error: UncertainPublishError },
    { name: 'server failure', respond: response => { response.statusCode = 500; response.end(); }, error: UncertainPublishError },
    { name: 'lost response', respond: response => { response.destroy(); }, error: UncertainPublishError },
    { name: 'invalid successful receipt', respond: response => { response.end('{"id":"not-a-receipt"}'); }, error: UncertainPublishError },
    { name: 'wrong account receipt', respond: response => { response.end('[{"postId":"123","integration":"another-account"}]'); }, error: UncertainPublishError },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    await withProvider(scenario.respond, async requests => {
      const target = account();
      await assert.rejects(savePostizDraft(job(target), target, variant(), integration()), scenario.error);
      assert.equal(requests.length, 1);
      assert.equal((requests[0]?.body as { type: string }).type, 'draft');
    });
  });
});

import { Router } from 'express';
import { z } from 'zod';
import { bindDraftAccount, bindDraftAccountSchema, configureDraftBridge, draftBridgeConnectionUrl, draftConnectorStatus, nativeDraftPlatformSchema } from '../core/draft-connectors.ts';
import { confirmDraftReceipt, saveDraftsInputSchema, saveRemoteDrafts } from '../core/remote-drafts.ts';
import { readState } from '../core/store.ts';

export const draftConnectorApi = Router();
draftConnectorApi.get('/publishing/draft-connectors', async (_req, res) => res.json(await draftConnectorStatus()));
draftConnectorApi.post('/publishing/draft-connectors/bridge', async (req, res) => res.json(await configureDraftBridge(req.body)));
draftConnectorApi.get('/publishing/draft-connectors/bridge-connection', async (_req, res) => res.json(await draftBridgeConnectionUrl()));
draftConnectorApi.post('/publishing/draft-connectors/accounts', async (req, res) => {
  const input = bindDraftAccountSchema.extend({ platform: nativeDraftPlatformSchema }).parse(req.body);
  res.json(await bindDraftAccount(input.platform, input));
});
draftConnectorApi.post('/accounts/:id/draft-connection', async (req, res) => {
  const input = bindDraftAccountSchema.extend({ adapter: z.literal('wechatsync') }).parse(req.body); const id = z.uuid().parse(req.params.id);
  const account = (await readState()).accounts.find(item => item.id === id);
  if (!account) throw new Error('Account not found.');
  res.json(await bindDraftAccount(account.platform, input, id));
});
draftConnectorApi.post('/drafts/:id/save-drafts', async (req, res) => res.json(await saveRemoteDrafts(z.uuid().parse(req.params.id), saveDraftsInputSchema.parse(req.body))));
draftConnectorApi.post('/jobs/:id/draft-receipt', async (req, res) => {
  const input = z.object({ id: z.string().min(1).max(200), url: z.url() }).parse(req.body);
  res.json(await confirmDraftReceipt(z.uuid().parse(req.params.id), input.id, input.url));
});

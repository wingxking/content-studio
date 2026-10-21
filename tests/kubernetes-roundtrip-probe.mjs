// Explicit owner read-only acceptance; execute inside each runtime's API container.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.STUDIO_RUNTIME_ROUNDTRIP, 'owner-read-only');
const moduleAt = name => import(pathToFileURL(resolve('src', 'core', `${name}.ts`)).href);
const [{ readState }, { listIndependentVideoProjects }, { dbRpc }, { draftBridgeStatus }] = await Promise.all(['store', 'video', 'database', 'draft-connectors'].map(moduleAt));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const [state, projects, scheduler, bridge, readiness] = await Promise.all([
  readState(), listIndependentVideoProjects(), dbRpc('studio_scheduler_status'), draftBridgeStatus(), fetch('http://127.0.0.1:4310/readyz'),
]);
assert.equal(readiness.status, 200); assert.equal(state.paused, true); assert.equal(scheduler.ready, false);
const articles = state.drafts.map(({ id, revision, brief, title, body, document, variants }) => ({ id, revision, brief, title, body, document, variants })).sort((a, b) => a.id.localeCompare(b.id));
const jobs = state.jobs.map(({ id, status, attempts, remoteId, remoteUrl, approvedHash, contentHash }) => ({ id, status, attempts, remoteId, remoteUrl, approvedHash, contentHash })).sort((a, b) => a.id.localeCompare(b.id));
console.log(JSON.stringify({ ready: readiness.status, paused: state.paused, schedulerEnabled: scheduler.ready, drafts: articles.length, jobs: jobs.length, videoProjects: projects.length, articleHash: hash(articles), videoHash: hash(projects.sort((a, b) => a.id.localeCompare(b.id))), deliveryHash: hash(jobs), bridgeConfigured: bridge.configured, bridgeConnected: bridge.connected }));

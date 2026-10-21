import assert from 'node:assert/strict';
import test from 'node:test';
import { dbRpc } from '../src/core/database.ts';

test('database CAS conflicts remain actionable without exposing SQL diagnostics or paths', async () => {
  const environment = { ...process.env }; const fetcher = globalThis.fetch;
  try {
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture'; delete process.env.STUDIO_DATA_DIR;
    globalThis.fetch = async () => Response.json({ code: 'P0001', message: 'Video project changed; refresh and retry', details: '/private/worker token=fixture' }, { status: 400 });
    await assert.rejects(dbRpc('studio_put_video_project'), error => error instanceof Error && /revision.*changed/u.test(error.message) && !/private|token/u.test(error.message));
    globalThis.fetch = async () => Response.json({ code: '23505', message: 'private internal constraint', details: '/private/worker' }, { status: 409 });
    await assert.rejects(dbRpc('studio_commit_article'), /revision.*changed/u);
    globalThis.fetch = async () => Response.json({ code: 'P0001', message: 'Invalid video identity' }, { status: 400 });
    await assert.rejects(dbRpc('studio_put_video_project'), /Supabase request failed \(HTTP 400\)/u);
  } finally { globalThis.fetch = fetcher; process.env = environment; }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDohAddresses } from '../src/core/research.ts';
test('trusted DNS answers retain public-only pinning and reject mismatched or synthetic replies', () => {
  const reply = { Status: 0, Question: [{ name: 'example.com.', type: 1 }], Answer: [{ type: 5, data: 'edge.example.com.' }, { type: 1, data: '93.184.216.34' }] };
  assert.deepEqual(parseDohAddresses(reply, 'example.com'), [{ address: '93.184.216.34', family: 4 }]);
  assert.throws(() => parseDohAddresses(reply, 'different.example'), /did not match/);
  assert.throws(() => parseDohAddresses({ ...reply, Answer: [{ type: 1, data: '198.18.0.30' }] }, 'example.com'), /safe public/);
  assert.throws(() => parseDohAddresses({ ...reply, Answer: [{ type: 1, data: '127.0.0.1' }] }, 'example.com'), /safe public/);
});

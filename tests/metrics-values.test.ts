import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricValuesSchema, metricRetryDelay } from '../src/core/metrics.ts';
const missing = { views: null, likes: null, comments: null, shares: null, favorites: null, clicks: null };
test('metrics retain real zero and missing values but reject an empty success and negative counts', () => {
 assert.deepEqual(metricValuesSchema.parse({ ...missing, views: 0 }), { ...missing, views: 0 });
 assert.throws(() => metricValuesSchema.parse(missing)); assert.throws(() => metricValuesSchema.parse({ ...missing, likes: -1 })); assert.throws(() => metricValuesSchema.parse({ ...missing, views: 1.5 }));
});
test('rate limits use seconds or HTTP dates and remain bounded by the collection window', () => {
 assert.equal(metricRetryDelay('120'), 120000); assert.equal(metricRetryDelay('bad'), 600000); assert.equal(metricRetryDelay('9999999'), 57600000); assert.equal(metricRetryDelay(new Date(180000).toUTCString(), 0), 180000);
});

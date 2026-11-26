'use strict';
const assert = require('node:assert/strict');
const { parseQuotaPools, RPC_PATH } = require('../wrapper/lib/quota');

const pools = parseQuotaPools({ response: { groups: [
  { displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.96802, resetTime: '2026-12-01T03:25:06Z' },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9309987, resetTime: '2026-11-25T18:01:13Z' },
  ] },
  { displayName: 'Claude and GPT models', buckets: [
    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.2121052, resetTime: '2026-11-26T02:52:55Z' },
    { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
  ] },
  { displayName: 'Unknown pool', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] },
] } });
assert.equal(RPC_PATH, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
assert.equal(pools.length, 2);
assert.equal(pools[0].kind, 'gemini');
assert.equal(pools[0].fiveHour.remainingFraction, 0.9309987);
assert.equal(pools[0].weekly.resetTime, '2026-12-01T03:25:06Z');
assert.equal(pools[1].kind, 'claude-gpt');
assert.equal(pools[1].fiveHour.remainingFraction, 1);
assert.equal(pools[1].weekly.remainingFraction, 0.2121052);
assert.equal(parseQuotaPools({ response: { groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remainingFraction: 4 }] }] } })[0].fiveHour.remainingFraction, 1);
assert.equal(parseQuotaPools({ response: { groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remainingFraction: -1 }] }] } })[0].fiveHour.remainingFraction, 0);
assert.equal(parseQuotaPools({ response: { groups: [] } }), null);
console.log('PASS: Gemini and Claude/GPT quota pools are mapped and fractions clamped.');

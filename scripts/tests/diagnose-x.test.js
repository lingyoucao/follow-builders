import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseX } from '../diagnose-x.js';

test('missing or malformed credentials fail before network access', async () => {
  for (const token of ['', 'Bearer token', 'token\n']) {
    let calls = 0;
    const result = await diagnoseX({ token, request: async () => { calls++; } });
    assert.equal(result.status, 'invalid_configuration');
    assert.equal(calls, 0);
  }
});
test('402 user lookup is recorded and no timeline request is sent', async () => {
  let calls = 0;
  const result = await diagnoseX({ token: 'test-token', request: async () => {
    calls++;
    return new Response(JSON.stringify({ title: 'CreditsDepleted', detail: 'Your account has no credits.' }), { status: 402 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'api_error');
  assert.equal(result.checks[0].title, 'CreditsDepleted');
});
test('successful user lookup and empty timeline prove both endpoints accessible', async () => {
  const urls = [];
  const result = await diagnoseX({ token: 'test-token', request: async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify(urls.length === 1 ? { data: { id: '1' } } : { data: [], meta: { result_count: 0 } }), { status: 200 });
  } });
  assert.equal(result.status, 'ok');
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get('max_results'), '5');
  assert.ok(!urls[1].searchParams.has('tweet.fields'));
  assert.ok(!urls[1].searchParams.has('since_id'));
});

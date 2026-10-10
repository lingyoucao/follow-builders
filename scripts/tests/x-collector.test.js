import test from 'node:test';
import assert from 'node:assert/strict';
import { collectX, mergeContent } from '../x-collector.js';
const account = { name: 'Builder', handle: 'builder' };
const tweet = id => ({ id, text: id, created_at: new Date().toISOString() });
const response = (data, next) => ({ ok: true, json: async () => ({ data, meta: { next_token: next } }) });
test('pagination cap preserves cursor and resumes remaining pages', async () => {
  const state = { xUsers: { builder: { id: '1', sinceId: '10' } } };
  const urls = [];
  const request = async url => { urls.push(url); return response([tweet('30')], 'next'); };
  const first = await collectX([account], 'token', state, { request, maxPages: 1 });
  assert.equal(first.x[0].tweets.length, 1);
  assert.equal(state.xUsers.builder.sinceId, '10');
  assert.equal(state.xUsers.builder.pending.nextToken, 'next');
  await collectX([account], 'token', state, { maxPages: 1, request: async url => { urls.push(url); return response([tweet('20')]); } });
  assert.match(urls[1], /pagination_token=next/);
  assert.match(urls[1], /since_id=10/);
  assert.equal(state.xUsers.builder.sinceId, '30');
  assert.equal(state.xUsers.builder.pending, undefined);
});
test('failure does not advance cursor and does not stop other accounts', async () => {
  const state = { xUsers: { builder: { id: '1', sinceId: '10' }, other: { id: '2' } } };
  const result = await collectX([account, { name: 'Other', handle: 'other' }], 'token', state, {
    request: async url => url.includes('/1/') ? { ok: false, status: 503 } : response([tweet('50')])
  });
  assert.equal(state.xUsers.builder.sinceId, '10');
  assert.equal(result.report.failed.length, 1);
  assert.equal(result.report.completed.length, 1);
});
test('retained content deduplicates and expires old posts', () => {
  const old = { ...tweet('1'), createdAt: '2000-01-01T00:00:00Z' };
  const current = { ...tweet('2'), createdAt: new Date().toISOString() };
  const rows = [{ ...account, tweets: [old, current] }];
  const result = mergeContent(rows, [{ ...account, tweets: [current] }]);
  assert.deepEqual(result[0].tweets.map(t => t.id), ['2']);
});
test('429 stops requests and reports unattempted accounts without changing cursors', async () => {
  const state = { xUsers: { builder: { id: '1', sinceId: '10' }, other: { id: '2' } } };
  let calls = 0;
  const result = await collectX([account, { name: 'Other', handle: 'other' }], 'token', state, {
    request: async () => { calls++; return { ok: false, status: 429 }; }
  });
  assert.equal(calls, 1);
  assert.equal(state.xUsers.builder.sinceId, '10');
  assert.deepEqual(result.report.skipped, ['other']);
});
test('empty timeline is a successful collection, disabled account is skipped', async () => {
  const state = { xUsers: { builder: { id: '1' } } };
  const result = await collectX([account, { handle: 'disabled', enabled: false }], 'token', state, { request: async () => response([]) });
  assert.deepEqual(result.report.completed, ['builder']);
  assert.deepEqual(result.report.skipped, ['disabled']);
  assert.ok(state.xUsers.builder.lastSuccessAt);
});
test('user lookup errors remain failures rather than silently disappearing', async () => {
  const result = await collectX([account], 'token', {}, { request: async () => response(undefined) });
  assert.equal(result.report.failed[0].handle, 'builder');
});
test('failure after a page retains data and continuation without advancing committed cursor', async () => {
  const state = { xUsers: { builder: { id: '1', sinceId: '10' } } };
  let calls = 0;
  const result = await collectX([account], 'token', state, { request: async () => ++calls === 1 ? response([tweet('30')], 'next') : { ok: false, status: 503 } });
  assert.equal(state.xUsers.builder.sinceId, '10');
  assert.equal(state.xUsers.builder.pending.nextToken, 'next');
  assert.equal(result.x[0].tweets[0].id, '30');
  assert.equal(state.xUsers.builder.lastSuccessAt, undefined);
});
test('rate limited runs resume at the blocked account instead of starving the tail', async () => {
  const accounts = [account, { name: 'Other', handle: 'other' }];
  const state = { xUsers: { builder: { id: '1' }, other: { id: '2' } } };
  await collectX(accounts, 'token', state, { request: async url => url.includes('/1/') ? response([]) : { ok: false, status: 429 } });
  const urls = [];
  await collectX(accounts, 'token', state, { request: async url => { urls.push(url); return response([]); } });
  assert.ok(new URL(urls[0]).pathname.endsWith('/users/2/tweets'));
});
test('transient failure retains first-run start time and successful pages for retry', async () => {
  const startTime = '2026-01-01T00:00:00Z';
  const state = { xUsers: { builder: { id: '1', pending: { startTime, newestId: '30', nextToken: 'page2' } } } };
  const result = await collectX([account], 'token', state, { request: async () => ({ ok: false, status: 503 }) });
  assert.equal(result.report.failed.length, 1);
  assert.equal(state.xUsers.builder.pending.startTime, startTime);
  assert.equal(state.xUsers.builder.pending.nextToken, 'page2');
});
test('invalid pagination token restarts the same window, not a moving lookback window', async () => {
  const startTime = '2026-01-01T00:00:00Z';
  const state = { xUsers: { builder: { id: '1', pending: { startTime, newestId: '30', nextToken: 'expired' } } } };
  await collectX([account], 'token', state, { request: async () => ({ ok: false, status: 400 }) });
  assert.equal(state.xUsers.builder.pending.startTime, startTime);
  assert.equal(state.xUsers.builder.pending.nextToken, undefined);
});
test('401 stops subsequent requests instead of retrying credentials across all accounts', async () => {
  let count = 0;
  const result = await collectX([account, { name: 'Other', handle: 'other' }], 'token', {}, {
    request: async () => { count++; return { ok: false, status: 401 }; }
  });
  assert.equal(count, 1);
  assert.deepEqual(result.report.skipped, ['other']);
  assert.equal(result.report.stopReason, 'HTTP 401');
});
test('field rejection retries current post field names and normalizes the response', async () => {
  const urls = [];
  const state = { xUsers: { builder: { id: '1' } } };
  const result = await collectX([account], 'token', state, {
    request: async url => {
      urls.push(new URL(url));
      if (new URL(url).searchParams.has('tweet.fields')) return { ok: false, status: 400, json: async () => ({ detail: 'Unsupported tweet.fields: note_tweet' }) };
      return response([{ ...tweet('30'), note_post: { text: 'full post' }, public_metrics: { repost_count: 5 }, referenced_posts: [{ type: 'quoted', id: '20' }] }]);
    }
  });
  assert.equal(urls.length, 2);
  assert.ok(urls[1].searchParams.has('post.fields'));
  assert.equal(state.xFieldFormat, 'post');
  assert.equal(result.x[0].tweets[0].text, 'full post');
  assert.equal(result.x[0].tweets[0].retweets, 5);
  assert.equal(result.x[0].tweets[0].quotedTweetId, '20');
});

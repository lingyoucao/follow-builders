import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('generator persists partial successes, reports failures, and retains content on empty rerun', async () => {
  const root = await mkdtemp(join(tmpdir(), 'follow-builders-test-'));
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'config'));
    for (const name of ['generate-feed.js', 'x-collector.js', 'import-x-accounts.js']) await copyFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(root, 'scripts', name));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'config/default-sources.json'), JSON.stringify({ x_accounts: [{ name: 'Good', handle: 'good' }, { name: 'Bad', handle: 'bad' }, { name: 'Disabled', handle: 'disabled', enabled: false }] }));
    await writeFile(join(root, 'feed-x.json'), JSON.stringify({ x: [{ handle: 'disabled', tweets: [{ id: '90', createdAt: new Date().toISOString() }] }, { handle: 'removed', tweets: [{ id: '91', createdAt: new Date().toISOString() }] }] }));
    const mock = join(root, 'mock.mjs');
    await writeFile(mock, `globalThis.fetch = async url => {
      if (url.includes('/username/bad')) return { ok: false, status: 404 };
      if (url.includes('/username/good')) return { ok: true, json: async () => ({ data: { id: '1' } }) };
      return { ok: true, json: async () => ({ data: process.env.EMPTY ? [] : [{ id: '100', text: 'hello', created_at: new Date().toISOString() }], meta: {} }) };
    };`);
    const run = extra => spawnSync(process.execPath, ['--import', mock, join(root, 'scripts/generate-feed.js'), '--tweets-only'], { env: { ...process.env, X_BEARER_TOKEN: 'mock', ...extra }, encoding: 'utf8' });
    const first = run({}); assert.equal(first.status, 1, first.stderr);
    const state = JSON.parse(await readFile(join(root, 'state-feed.json'), 'utf8'));
    assert.equal(state.xUsers.good.sinceId, '100');
    const report = JSON.parse(await readFile(join(root, 'reports/x-collection.json'), 'utf8'));
    assert.deepEqual(report.completed, ['good']); assert.equal(report.failed.length, 1);
    const second = run({ EMPTY: '1' }); assert.equal(second.status, 1, second.stderr);
    const feed = JSON.parse(await readFile(join(root, 'feed-x.json'), 'utf8'));
    assert.deepEqual(feed.x.map(account => account.handle), ['good']);
    assert.equal(feed.x[0].tweets.length, 1); assert.equal(feed.x[0].tweets[0].id, '100');
  } finally { await rm(root, { recursive: true, force: true }); }
});

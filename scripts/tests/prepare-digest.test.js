import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../prepare-digest.js', import.meta.url));
test('local feed mode uses repository data and prompts without network', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const output = JSON.parse(execFileSync(process.execPath, ['scripts/prepare-digest.js', '--feed-dir', root], { cwd: root, env: { ...process.env, FEED_BASE_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 10000 }));
  assert.ok(Array.isArray(output.x));
  assert.ok(output.prompts.summarize_tweets);
  assert.ok(!output.errors?.some(e => e.includes('tweet feed')));
});
test('missing local feeds return an explicit error status and nonzero exit code', () => {
  const { status, stdout } = spawnSync(process.execPath, [script, '--feed-dir', '/nonexistent-follow-builders-test'], { encoding: 'utf8' });
  assert.equal(status, 1);
  assert.equal(JSON.parse(stdout).status, 'error');
});
test('daily digests exclude retained older posts while weekly digests include them', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'digest-window-test-'));
  try {
    const now = Date.now();
    await writeFile(join(directory, 'feed-x.json'), JSON.stringify({ generatedAt: new Date(now).toISOString(), x: [{ handle: 'builder', tweets: [
      { id: 'today', createdAt: new Date(now - 3600000).toISOString() },
      { id: 'older', createdAt: new Date(now - 48 * 3600000).toISOString() }
    ] }] }));
    const run = () => JSON.parse(execFileSync(process.execPath, [script, '--feed-dir', directory], { env: { ...process.env, HOME: directory }, encoding: 'utf8' }));
    assert.deepEqual(run().x[0].tweets.map(tweet => tweet.id), ['today']);
    await mkdir(join(directory, '.follow-builders'));
    await writeFile(join(directory, '.follow-builders/config.json'), JSON.stringify({ frequency: 'weekly' }));
    assert.deepEqual(run().x[0].tweets.map(tweet => tweet.id), ['today', 'older']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

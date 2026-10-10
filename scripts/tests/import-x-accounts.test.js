import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeAccounts } from '../import-x-accounts.js';

test('JSON catalog contains 226 unique accounts and runtime config contains their union', async () => {
  const catalog = JSON.parse(await readFile(new URL('../../config/x-account-catalog.json', import.meta.url), 'utf8'));
  const config = JSON.parse(await readFile(new URL('../../config/default-sources.json', import.meta.url), 'utf8'));
  assert.equal(catalog.accounts.length, 226);
  assert.equal(new Set(catalog.accounts.map(a => a.handle.toLowerCase())).size, 226);
  assert.equal(config.x_accounts.length, 236);
  for (const account of [...catalog.accounts, ...config.x_accounts]) {
    assert.equal(account.url.toLowerCase(), `https://x.com/${account.handle.toLowerCase()}`);
  }
  assert.ok(catalog.accounts.every(a => config.x_accounts.some(b => b.handle.toLowerCase() === a.handle.toLowerCase())));
});
test('merge accepts changing catalog sizes and preserves existing settings case-insensitively', () => {
  const original = [{ name: 'Original', handle: 'Builder', enabled: false }];
  const catalog = [{ name: 'New name', handle: 'builder', enabled: true }, { name: 'Other', handle: 'other' }];
  const result = mergeAccounts(original, catalog);
  assert.deepEqual(result[0], { ...original[0], url: 'https://x.com/Builder' });
  assert.equal(result.length, 2);
  assert.deepEqual(mergeAccounts(result, catalog), result);
});
test('invalid or duplicate accounts are rejected before any configuration is written', () => {
  for (const list of [null, [], [{ name: 'X', handle: 'ok', url: 'https://x.com/wrong' }], [{ name: 'X', handle: 'bad-handle' }], [{ name: '', handle: 'ok' }], [{ name: 'X', handle: 'ok', enabled: 'false' }], [{ name: 'A', handle: 'dup' }, { name: 'B', handle: 'DUP' }]]) {
    assert.throws(() => mergeAccounts([], list));
  }
});
test('CLI imports JSON from an unrelated working directory and rejects invalid input without overwriting', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'x-catalog-test-'));
  try {
    const source = join(directory, 'catalog.json');
    const configPath = join(directory, 'config.json');
    const script = fileURLToPath(new URL('../import-x-accounts.js', import.meta.url));
    await writeFile(source, JSON.stringify({ schemaVersion: 1, accounts: [{ name: 'Added', handle: 'added' }] }));
    await writeFile(configPath, JSON.stringify({ blogs: ['preserved'], x_accounts: [{ name: 'Existing', handle: 'existing' }] }));
    const run = () => spawnSync(process.execPath, [script, '--source', source, '--config', configPath], { cwd: directory, encoding: 'utf8' });
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const saved = await readFile(configPath, 'utf8');
    assert.deepEqual(JSON.parse(saved).blogs, ['preserved']);
    assert.equal(JSON.parse(saved).x_accounts.length, 2);
    assert.equal(run().status, 0);
    assert.equal(await readFile(configPath, 'utf8'), saved);
    await writeFile(source, JSON.stringify({ schemaVersion: 1, accounts: [{ name: 'Invalid', handle: 'bad-handle' }] }));
    assert.equal(run().status, 1);
    assert.equal(await readFile(configPath, 'utf8'), saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

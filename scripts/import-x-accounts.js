import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_SOURCE = new URL('../config/x-account-catalog.json', import.meta.url);
const DEFAULT_CONFIG = new URL('../config/default-sources.json', import.meta.url);

function validateAccounts(accounts, label, allowEmpty = false) {
  if (!Array.isArray(accounts) || (!allowEmpty && !accounts.length)) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const seen = new Set();
  for (const account of accounts) {
    if (!account || typeof account.name !== 'string' || !account.name.trim()) {
      throw new Error(`${label}: each account needs a name`);
    }
    if (typeof account.handle !== 'string' || !/^[a-z0-9_]{1,15}$/i.test(account.handle)) {
      throw new Error(`${label}: invalid handle ${account.handle}`);
    }
    if (account.url !== undefined && (typeof account.url !== 'string' || account.url.toLowerCase().replace(/\/$/, '') !== `https://x.com/${account.handle.toLowerCase()}`)) {
      throw new Error(`${label}: url must match X profile for @${account.handle}`);
    }
    if (account.enabled !== undefined && typeof account.enabled !== 'boolean') {
      throw new Error(`${label}: enabled must be boolean for @${account.handle}`);
    }
    const key = account.handle.toLowerCase();
    if (seen.has(key)) throw new Error(`${label}: duplicate handle @${account.handle}`);
    seen.add(key);
  }
}

export function mergeAccounts(existing, incoming) {
  validateAccounts(existing, 'Existing accounts', true);
  validateAccounts(incoming, 'Catalog accounts');
  const merged = new Map(existing.map(account => [account.handle.toLowerCase(), { ...account }]));
  for (const account of incoming) {
    const key = account.handle.toLowerCase();
    const original = merged.get(key);
    // Enrich overlapping accounts without overwriting existing names or settings.
    merged.set(key, { enabled: true, ...account, ...original });
  }
  return [...merged.values()].map(account => ({
    ...account,
    url: account.url || `https://x.com/${account.handle}`,
  }));
}

async function main() {
  let source = DEFAULT_SOURCE;
  let configPath = DEFAULT_CONFIG;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!['--source', '--config'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node import-x-accounts.js [--source catalog.json] [--config sources.json]');
    }
    const path = resolve(args[i + 1]);
    if (args[i] === '--source') source = path;
    else configPath = path;
    i++;
  }
  const catalog = JSON.parse(await readFile(source, 'utf8'));
  if (catalog.schemaVersion !== 1) throw new Error('Unsupported catalog schemaVersion; expected 1');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.x_accounts = mergeAccounts(config.x_accounts, catalog.accounts);
  const path = configPath instanceof URL ? fileURLToPath(configPath) : configPath;
  const serialized = JSON.stringify(config, null, 2) + '\n';
  if (await readFile(configPath, 'utf8') !== serialized) {
    await writeFile(`${path}.tmp`, serialized);
    await rename(`${path}.tmp`, path);
  }
  console.log(`Merged ${catalog.accounts.length} catalog accounts: ${config.x_accounts.length} total`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

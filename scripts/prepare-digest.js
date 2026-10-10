#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const DEFAULT_BASE = 'https://raw.githubusercontent.com/lingyoucao/follow-builders/main';
const FEED_BASE = (process.env.FEED_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
const dirIndex = process.argv.indexOf('--feed-dir');
if (dirIndex >= 0 && !process.argv[dirIndex + 1]) throw new Error('--feed-dir requires a directory');
const FEED_DIR = dirIndex >= 0 ? process.argv[dirIndex + 1] : null;
const PROMPTS_BASE = (process.env.PROMPTS_BASE_URL || `${FEED_BASE}/prompts`).replace(/\/$/, '');
async function loadFeed(filename) {
  try { return FEED_DIR ? JSON.parse(await readFile(join(FEED_DIR, filename), 'utf8')) : await fetchJSON(`${FEED_BASE}/${filename}`); }
  catch { return null; }
}
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  return res.text();
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all three feeds
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    loadFeed('feed-x.json'),
    loadFeed('feed-podcasts.json'),
    loadFeed('feed-blogs.json')
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');
  if (feedX?.collection?.incomplete?.length) errors.push(`Tweet feed has ${feedX.collection.incomplete.length} accounts awaiting pagination`);
  const enabledSkipped = (feedX?.collection?.skipped || []).filter(handle => !(feedX?.collection?.disabled || []).includes(handle));
  if (enabledSkipped.length) errors.push(`Tweet feed skipped ${enabledSkipped.length} accounts; see collection report`);
  if (feedX?.errors?.length) {
    errors.push(
      ...feedX.errors.map((error) => `Tweet feed problem: ${error}`)
    );
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(
      ...feedPodcasts.errors.map((error) => `Podcast feed problem: ${error}`)
    );
  }
  if (feedBlogs?.errors?.length) {
    errors.push(
      ...feedBlogs.errors.map((error) => `Blog feed problem: ${error}`)
    );
  }

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = FEED_DIR ? null : await fetchText(`${PROMPTS_BASE}/${filename}`).catch(() => null);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // Retention is longer than a daily digest window. Anchor the window to the
  // collection time so a once-daily feed does not lose posts before delivery.
  const digestHours = config.frequency === 'weekly' ? 168 : 24;
  const feedTime = Date.parse(feedX?.generatedAt);
  const windowEnd = Number.isFinite(feedTime) ? feedTime : Date.now();
  const digestX = (feedX?.x || []).map(account => ({
    ...account,
    tweets: (account.tweets || []).filter(tweet => {
      const created = Date.parse(tweet.createdAt);
      return created >= windowEnd - digestHours * 3600000 && created <= windowEnd;
    }),
  })).filter(account => account.tweets.length);
  if (Number.isFinite(feedTime) && Date.now() - feedTime > 36 * 3600000) {
    errors.push('Tweet feed is over 36 hours old; collection may have stopped');
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: !feedX ? 'error' : errors.length ? 'partial' : 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: feedPodcasts?.podcasts || [],
    x: digestX,
    blogs: feedBlogs?.blogs || [],

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: digestX.length,
      totalTweets: digestX.reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
  if (!feedX) process.exitCode = 1;
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});

const BASE = 'https://api.x.com/2';

export function mergeContent(previous = [], incoming = [], days = 7, now = Date.now()) {
  const accounts = new Map();
  for (const row of [...previous, ...incoming]) {
    const key = row.handle.toLowerCase();
    const old = accounts.get(key);
    const tweets = new Map((old?.tweets || []).map(tweet => [tweet.id, tweet]));
    for (const tweet of row.tweets || []) tweets.set(tweet.id, tweet);
    accounts.set(key, {
      ...old, ...row,
      tweets: [...tweets.values()]
        .filter(tweet => Date.parse(tweet.createdAt) >= now - days * 86400000)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    });
  }
  return [...accounts.values()].filter(account => account.tweets.length);
}

// Only retain diagnostic fields, never request headers or arbitrary response keys.
export function redactXText(value, token = '') {
  let text = String(value);
  const secrets = new Set([token, encodeURIComponent(token)]);
  try { secrets.add(decodeURIComponent(token)); } catch {}
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]').slice(0, 2000);
}

export async function readXError(response, token = '', parsedBody) {
  let body = parsedBody;
  if (body === undefined) {
    try {
      if (response.text) {
        const raw = await response.text();
        try { body = JSON.parse(raw); }
        catch { body = { detail: raw }; }
      } else body = response.json ? await response.json() : {};
    } catch { body = {}; }
  }
  const diagnostic = { status: response.status };
  for (const field of ['title', 'detail', 'type', 'reason']) {
    if (body && typeof body[field] === 'string') diagnostic[field] = redactXText(body[field], token);
  }
  if (Array.isArray(body?.errors)) {
    diagnostic.errors = body.errors.slice(0, 5).map(error => {
      const clean = {};
      for (const field of ['title', 'detail', 'type', 'reason']) {
        if (typeof error?.[field] === 'string') clean[field] = redactXText(error[field], token);
      }
      return clean;
    });
  }
  const requestId = response.headers?.get('x-request-id') || response.headers?.get('x-transaction-id');
  if (requestId) diagnostic.requestId = redactXText(requestId, token);
  for (const field of ['x-rate-limit-remaining', 'x-rate-limit-reset', 'retry-after']) {
    const value = response.headers?.get(field);
    if (value) diagnostic[field] = redactXText(value, token);
  }
  return diagnostic;
}

function apiError(stage, endpoint, diagnostic) {
  const detail = diagnostic.detail || diagnostic.title;
  const error = new Error(`${stage} HTTP ${diagnostic.status}${detail ? `: ${detail}` : ''}`);
  error.diagnostic = { stage, endpoint, ...diagnostic };
  return error;
}

async function requestX(url, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      if (![500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
}

function timelineParams(pending, format) {
  const params = new URLSearchParams({ max_results: '100', exclude: 'retweets,replies' });
  if (format === 'post') {
    params.set('post.fields', 'created_at,public_metrics,note_post');
    params.set('expansions', 'referenced_posts');
  } else {
    params.set('tweet.fields', 'created_at,public_metrics,referenced_tweets,note_tweet');
  }
  if (pending.sinceId) params.set('since_id', pending.sinceId);
  else params.set('start_time', pending.startTime);
  if (pending.endTime) params.set('end_time', pending.endTime);
  if (pending.nextToken) params.set('pagination_token', pending.nextToken);
  return params;
}

function normalizeTweet(tweet, handle) {
  const references = tweet.referenced_tweets || tweet.referenced_posts || [];
  return {
    id: tweet.id,
    text: tweet.note_tweet?.text || tweet.note_post?.text || tweet.text,
    createdAt: tweet.created_at,
    url: `https://x.com/${handle}/status/${tweet.id}`,
    likes: tweet.public_metrics?.like_count || 0,
    retweets: tweet.public_metrics?.retweet_count ?? tweet.public_metrics?.repost_count ?? 0,
    replies: tweet.public_metrics?.reply_count || 0,
    isQuote: references.some(reference => reference.type === 'quoted'),
    quotedTweetId: references.find(reference => reference.type === 'quoted')?.id || null,
  };
}

export async function collectX(accounts, token, state, options = {}) {
  const request = options.request || (url => requestX(url, token));
  const maxPages = options.maxPages ?? 3;
  const lookback = options.lookbackHours ?? 24;
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isFinite(lookback) || lookback <= 0) {
    throw new Error('Invalid X collection limits');
  }
  state.xUsers ||= {};
  const report = {
    generatedAt: new Date().toISOString(), configured: accounts.length,
    completed: [], failed: [], incomplete: [], skipped: [], disabled: [],
  };
  const x = [];
  let stopped = false;
  const start = Math.max(0, accounts.findIndex(account => account.handle.toLowerCase() === state.xNextHandle));
  const ordered = [...accounts.slice(start), ...accounts.slice(0, start)];
  delete state.xNextHandle;

  for (const account of ordered) {
    if (account.enabled === false || stopped) {
      report.skipped.push(account.handle);
      if (account.enabled === false) report.disabled.push(account.handle);
      continue;
    }
    const key = account.handle.toLowerCase();
    const user = state.xUsers[key] ||= {};
    const tweets = [];
    let pending;
    let status;
    try {
      if (!user.id) {
        const response = await request(`${BASE}/users/by/username/${encodeURIComponent(account.handle)}?user.fields=description`);
        status = response.status;
        if (!response.ok) throw apiError('User lookup', `/2/users/by/username/${account.handle}`, await readXError(response, token));
        const body = await response.json();
        if (!body.data?.id) throw new Error('User lookup returned no user');
        user.id = body.data.id;
        user.bio = body.data.description || '';
      }
      const endTime = new Date(Date.now() - 10000).toISOString();
      pending = user.pending ? { ...user.pending } : {
        sinceId: user.sinceId,
        startTime: user.sinceId ? undefined : new Date(user.lastWindowEnd
          ? Date.parse(user.lastWindowEnd) - 1000
          : Date.parse(endTime) - lookback * 3600000).toISOString(),
        endTime,
        newestId: user.sinceId,
      };
      let complete = false;
      for (let page = 0; page < maxPages; page++) {
        const url = `${BASE}/users/${user.id}/tweets`;
        let response = await request(`${url}?${timelineParams(pending, state.xFieldFormat)}`);
        let errorDetails;
        // New X API documentation uses post.fields/note_post. Switch only on a
        // field-related rejection, preserving compatibility with legacy deployments.
        if (response.status === 400 && state.xFieldFormat !== 'post') {
          const details = await readXError(response, token);
          errorDetails = details;
          if (/tweet\.fields|note_tweet|referenced_tweets/.test(JSON.stringify(details))) {
            response = await request(`${url}?${timelineParams(pending, 'post')}`);
            errorDetails = undefined;
            if (response.ok) state.xFieldFormat = 'post';
          }
        }
        status = response.status;
        if (!response.ok) {
          if (status === 404) delete user.id;
          if (status === 400 && pending.nextToken) delete pending.nextToken;
          throw apiError('Timeline', `/2/users/${user.id || 'unknown'}/tweets`, errorDetails || await readXError(response, token));
        }
        const body = await response.json();
        if (body.errors?.length) {
          throw new Error(`Timeline errors: ${body.errors.map(error => error.detail || error.title).join('; ')}`);
        }
        for (const tweet of body.data || []) {
          // Validate before committing the page cursor. Invalid responses replay safely.
          if (!/^\d+$/.test(tweet.id) || !Number.isFinite(Date.parse(tweet.created_at))) {
            throw new Error('Timeline returned a post without valid id/created_at');
          }
          if (!pending.newestId || BigInt(tweet.id) > BigInt(pending.newestId)) pending.newestId = tweet.id;
          tweets.push(normalizeTweet(tweet, account.handle));
        }
        pending.nextToken = body.meta?.next_token;
        if (!pending.nextToken) {
          complete = true;
          break;
        }
      }
      if (complete) {
        if (pending.newestId) user.sinceId = pending.newestId;
        if (pending.endTime) user.lastWindowEnd = pending.endTime;
        delete user.pending;
        user.lastSuccessAt = new Date().toISOString();
        report.completed.push(account.handle);
      } else {
        user.pending = pending;
        report.incomplete.push(account.handle);
      }
    } catch (error) {
      // Keep the original time window and the last successfully read page.
      // Invalid pagination tokens restart that same window; transient errors resume it.
      if (pending) user.pending = pending;
      report.failed.push({ handle: account.handle, error: redactXText(error.message, token), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) });
      if ([401, 402, 429].includes(status)) {
        stopped = true;
        state.xNextHandle = key;
        report.stopReason = `HTTP ${status}`;
      }
    }
    if (tweets.length) x.push({ source: 'x', ...account, bio: user.bio || '', tweets });
  }
  return { x, report };
}

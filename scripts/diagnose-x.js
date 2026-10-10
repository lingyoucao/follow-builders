import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readXError, redactXText } from './x-collector.js';

export async function diagnoseX({ token = '', handle = 'karpathy', request } = {}) {
  const report = { generatedAt: new Date().toISOString(), status: 'invalid_configuration', checks: [] };
  // Detect common copy/paste mistakes without logging the token or altering it.
  if (!token || !/^[!-~]+$/.test(token) || /^Bearer\s/i.test(token)) {
    report.error = 'X_BEARER_TOKEN must contain only the token, without whitespace or a Bearer prefix';
    return report;
  }
  if (!/^[a-z0-9_]{1,15}$/i.test(handle)) {
    report.error = 'Invalid account handle';
    return report;
  }
  report.configuration = { tokenPresent: true, tokenFormatValid: true, handle };
  request ||= url => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  let stage = 'user_lookup';
  let endpoint = `/2/users/by/username/${handle}`;
  try {
    // Minimal lookup: no optional fields, no batch, no feed, no cached user ID.
    const userResponse = await request(`https://api.x.com${endpoint}`);
    if (!userResponse.ok) {
      report.checks.push({ stage, endpoint, ...await readXError(userResponse, token) });
      report.status = 'api_error';
      return report;
    }
    const user = await userResponse.json();
    if (!/^\d+$/.test(user.data?.id)) throw new Error('User lookup succeeded but returned no valid user ID');
    report.checks.push({ stage, endpoint, status: userResponse.status, userIdResolved: true });
    stage = 'user_timeline';
    endpoint = `/2/users/${user.data.id}/tweets`;
    // Minimum allowed page size, no optional fields, filters, or saved cursors.
    const timelineResponse = await request(`https://api.x.com${endpoint}?max_results=5`);
    if (!timelineResponse.ok) {
      report.checks.push({ stage, endpoint, ...await readXError(timelineResponse, token) });
      report.status = 'api_error';
      return report;
    }
    const timeline = await timelineResponse.json();
    if (timeline.errors?.length) {
      report.checks.push({ stage, endpoint, ...await readXError(timelineResponse, token, timeline) });
      report.status = 'api_error';
      return report;
    }
    report.checks.push({ stage, endpoint, status: timelineResponse.status, postsReturned: timeline.data?.length || 0 });
    report.status = 'ok';
  } catch (error) {
    report.status = 'request_error';
    report.checks.push({ stage, endpoint, error: redactXText(error.message, token) });
  }
  return report;
}

async function main() {
  const report = await diagnoseX({ token: process.env.X_BEARER_TOKEN, handle: process.argv[2] || 'karpathy' });
  const directory = new URL('../reports/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('x-diagnostic.json', directory), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Unable to save X diagnostic report'); process.exitCode = 1; });
}

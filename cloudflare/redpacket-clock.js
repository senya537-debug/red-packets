// Cloudflare Worker: create a separate Worker named redpacket-clock.
// Secret: GH_DISPATCH_TOKEN (fine-grained GitHub PAT, only red-packets repository,
// Repository permissions > Actions: Read and write).
// Cron Trigger: * * * * *
// GitHub must use the updated square_access_check.yml with the scheduled mode.
// Run publish manually once to enable your Telegram group before enabling this clock.
// HTTP requests expose health only. Dispatch is performed by the scheduled handler.

const BUILD = 'redpacket-clock-v2';
const REPOSITORY = 'senya537-debug/red-packets';
const WORKFLOW = 'square_access_check.yml';
const BRANCH = 'main';
const STALE_MS = 20 * 60 * 1000;
const API = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;

function tokenOf(env) {
  return typeof env.GH_DISPATCH_TOKEN === 'string' ? env.GH_DISPATCH_TOKEN.trim() : '';
}

async function github(path, method, token, body) {
  const response = await fetch(API + path, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'RedPacketCloudflareClock',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!response.ok) {
    const hint = response.status === 401 ? 'token expired or invalid'
      : response.status === 403 ? 'check Actions read/write permission and GitHub limits'
      : response.status === 404 ? 'check repository, workflow file, and token repository access'
      : response.status === 422 ? 'update GitHub workflow first; it must accept mode scheduled'
      : 'GitHub API request failed';
    throw new Error(`GitHub HTTP ${response.status}: ${hint}`);
  }
  return response;
}

export async function tick(env) {
  const token = tokenOf(env);
  if (!token) throw new Error('Add Cloudflare Secret GH_DISPATCH_TOKEN');

  // Avoid building a queue when a recent scanner run is still active.
  // A run older than STALE_MS is stuck on GitHub's side (for example after HTTP 500s) and must not block the clock forever.
  const counts = await Promise.all(['in_progress', 'queued'].map(async status => {
    const response = await github(`/runs?status=${status}&per_page=10`, 'GET', token);
    const data = await response.json();
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs)) {
      throw new Error('Unexpected GitHub run-list response; dispatch skipped');
    }
    return data.workflow_runs.filter(run => Date.now() - Date.parse(run.created_at) < STALE_MS).length;
  }));
  if (counts.some(count => count > 0)) return {build: BUILD, status: 'busy', dispatched: false};

  // One dispatch attempt per cron event. A lost response is not blindly retried.
  const response = await github('/dispatches', 'POST', token, {
    ref: BRANCH,
    inputs: {mode: 'scheduled'},
  });
  let details = null;
  if (response.status !== 204) {
    try {details = await response.json();} catch {}
  }
  return {
    build: BUILD,
    status: 'dispatched',
    dispatched: true,
    http_status: response.status,
    ...(Number.isSafeInteger(details?.workflow_run_id) ? {workflow_run_id: details.workflow_run_id} : {}),
  };
}

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, HEAD'}});
    }
    const health = {
      build: BUILD,
      repository: REPOSITORY,
      workflow: WORKFLOW,
      token_present: Boolean(tokenOf(env)),
      expected_cron: '* * * * *',
      note: 'This page does not launch jobs. Cron events do. Check Cloudflare cron logs and GitHub automatic runs.',
    };
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(health, null, 2), {
      headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
    });
  },

  async scheduled(controller, env) {
    try {
      const result = await tick(env);
      console.log(JSON.stringify({...result, cron: controller.cron, at: new Date().toISOString()}));
    } catch (error) {
      const token = tokenOf(env);
      let message = String(error?.message || error);
      if (token) message = message.split(token).join('[REDACTED]');
      message = message.replace(/github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]').slice(0,250);
      console.error('Red Packet clock: ' + message);
      throw new Error(message);
    }
  },
};

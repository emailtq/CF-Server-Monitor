import { authenticateNodeRequest } from '../middleware/nodeAuth.js';

export async function handleMonitorAgentUpgrade(request, env, url = new URL(request.url)) {
  if (request.method !== 'GET' || url.pathname !== '/api/agent/ws') return null;
  if (url.protocol !== 'https:') return Response.json({error:'node_https_required'}, {status:403});
  let principal;
  try { principal = await authenticateNodeRequest(request, env.DB); }
  catch (_) { return new Response('Node authentication unavailable', {status:503}); }
  if (!principal) return new Response('Invalid node token', {status:401});
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket upgrade', {status:426});
  if (!env.METRICS_BROADCASTER) return new Response('Node session unavailable', {status:503});
  const headers = new Headers(request.headers);
  headers.set('X-Real-Origin', url.origin);
  if (request.cf?.country) headers.set('cf-ipcountry', request.cf.country);
  try {
    const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
    return await stub.fetch(new Request(`https://metrics.internal/monitor-agent${url.search}`, {headers}));
  } catch (_) { return new Response('Node session unavailable', {status:503}); }
}

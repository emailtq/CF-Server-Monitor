import { loadMonitorCompatAccess, MONITOR_COMPAT_LIVE_URL } from '../services/monitorCompatAccess.js';
import { createNotFoundResponse } from '../utils/errors.js';
import { loadMonitorCompatSnapshot } from '../services/monitorCompatSnapshot.js';
import { loadMonitorCompatHistory } from '../services/monitorCompatHistory.js';

// Retain the existing export for callers of the access gate.
export { loadMonitorCompatAccess };

const DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };

async function openMonitorCompatSocket(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE });
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade request', { status: 426, headers: NO_STORE });
  }
  try {
    const namespace = env.METRICS_BROADCASTER;
    // Forward no credentials, proxy headers, or query string to the internal public-only endpoint.
    return await namespace.get(namespace.idFromName('global')).fetch(MONITOR_COMPAT_LIVE_URL, {
      headers: { Upgrade: 'websocket' }
    });
  } catch {
    return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
  }
}

export async function handleMonitorCompat(request, env, url) {
  const host = env.MONITOR_COMPAT_HOST;
  if (typeof host !== 'string' || host.length > 253 || !DNS_HOSTNAME.test(host) ||
      url.hostname !== host.toLowerCase()) return null;

  const isMe = url.pathname === '/api/me';
  const isNodes = url.pathname === '/api/nodes';
  const isLive = url.pathname === '/api/ws';
  const isDefaultConfig = url.pathname === '/api/themes/default/config';
  const historyId = Number(/^\/api\/nodes\/([1-9]\d*)\/metrics$/.exec(url.pathname)?.[1]);
  const isHistory = Number.isSafeInteger(historyId);
  if (!isMe && !isNodes && !isLive && !isDefaultConfig && !isHistory) return createNotFoundResponse();
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'GET' } });
  }
  if (isLive) return openMonitorCompatSocket(request, env, url);

  const { status, siteName, display } = await loadMonitorCompatAccess(env.DB);
  if (!isMe) {
    if (status !== 200) {
      const error = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable';
      return Response.json({ error }, { status, headers: NO_STORE });
    }
    try {
      if (isDefaultConfig) return Response.json({}, { headers: NO_STORE });
      if (isNodes) return Response.json(await loadMonitorCompatSnapshot(env, { display }), { headers: NO_STORE });
      const result = await loadMonitorCompatHistory(env.DB, historyId, url.searchParams);
      if (result === null) return createNotFoundResponse();
      if (result === false) return Response.json({ error: 'Invalid history query' }, { status: 400, headers: NO_STORE });
      return Response.json(result, { headers: NO_STORE });
    } catch {
      return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
    }
  }
  return Response.json({
    authed: false,
    github: false,
    public_page: status === 200,
    site_name: siteName,
    history_days: 1
  }, { headers: NO_STORE });
}

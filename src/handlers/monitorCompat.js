import { loadMonitorCompatAccess, MONITOR_COMPAT_LIVE_URL } from '../services/monitorCompatAccess.js';
import { createNotFoundResponse } from '../utils/errors.js';
import { loadMonitorCompatSnapshot } from '../services/monitorCompatSnapshot.js';
import { loadMonitorCompatHistory } from '../services/monitorCompatHistory.js';

// Retain the existing export for callers of the access gate.
export { loadMonitorCompatAccess };

const DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };
const MONITOR_COMPAT_THEMES = new Set(['default', 'serverstatus']);
const MONITOR_ADMIN_GET_PATHS = new Set([
  '/admin', '/admin/', '/api/config', '/theme'
]);
const MONITOR_ADMIN_POST_PATHS = new Set([
  '/admin/api', '/updateDatabase', '/clearHistory'
]);

function isMonitorAdminRoute(request, pathname) {
  if (MONITOR_ADMIN_GET_PATHS.has(pathname) && request.method === 'GET') return true;
  if (MONITOR_ADMIN_POST_PATHS.has(pathname) && request.method === 'POST') return true;
  return request.method === 'GET' &&
    /^\/admin\/api\/terminal\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/ws$/.test(pathname);
}

function monitorCompatThemePath(pathname, theme) {
  const nodePath = /^\/node\/([1-9]\d*)$/.exec(pathname);
  if (pathname === '/' || (nodePath && Number.isSafeInteger(Number(nodePath[1])))) return 'index.html';
  if (pathname === '/favicon.svg' || pathname === '/apple-touch-icon.png') return pathname.slice(1);
  if (!pathname.startsWith('/assets/')) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname.slice('/assets/'.length));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\\')) return null;
  const parts = decoded.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return `assets/${parts.map(encodeURIComponent).join('/')}`;
}

async function serveMonitorCompatTheme(request, env, url) {
  const theme = typeof env.MONITOR_COMPAT_THEME === 'string' ? env.MONITOR_COMPAT_THEME : '';
  if (!MONITOR_COMPAT_THEMES.has(theme) || !env.ASSETS || !['GET', 'HEAD'].includes(request.method)) return null;

  const relativePath = monitorCompatThemePath(url.pathname, theme);
  if (!relativePath) return null;
  let response;
  try {
    response = await env.ASSETS.fetch(new Request(`http://monitor-theme/_monitor_theme/${theme}/${relativePath}${url.search}`, {
      method: request.method
    }));
  } catch {
    return createNotFoundResponse();
  }
  if (!response.ok) return createNotFoundResponse();
  if (request.method === 'HEAD') {
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return response;
}

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

  // Let the existing CF admin handlers enforce their auth, Turnstile, and terminal checks.
  if (isMonitorAdminRoute(request, url.pathname)) return null;

  const themeResponse = await serveMonitorCompatTheme(request, env, url);
  if (themeResponse) return themeResponse;

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

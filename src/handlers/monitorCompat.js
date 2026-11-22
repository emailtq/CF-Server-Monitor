import { loadMonitorCompatAccess, MONITOR_COMPAT_LIVE_URL } from '../services/monitorCompatAccess.js';
import { createNotFoundResponse } from '../utils/errors.js';
import { loadMonitorCompatSnapshot } from '../services/monitorCompatSnapshot.js';
import { loadMonitorCompatHistory } from '../services/monitorCompatHistory.js';
import { loadMonitorThemes } from '../services/monitorThemes.js';
import { MONITOR_DNS_HOSTNAME, MONITOR_PREVIEW_PARAM } from '../shared/monitorThemes.js';
import { resolveMonitorPreview, monitorPreviewHtml } from './monitorThemePreview.js';
import { loadMonitorViewerAccess, MONITOR_VIEWER_LIVE_URL, monitorCookie, MONITOR_VERIFICATION_COOKIE } from '../services/monitorViewerAccess.js';
import { handleMonitorAccess, serveMonitorAccessGate } from './monitorAccess.js';
import { getMonitorCompatIds, MONITOR_COMPAT_VISIBLE } from '../database/monitorCompatIds.js';

// Retain the existing export for callers of the access gate.
export { loadMonitorCompatAccess };

const NO_STORE = { 'Cache-Control': 'no-store' };
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

function monitorCompatThemePath(pathname) {
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

async function serveMonitorCompatTheme(request, env, url, preview, defaultFrontend) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const relativePath = monitorCompatThemePath(url.pathname);
  if (!relativePath) return null;
  if (!env.ASSETS) return createNotFoundResponse();
  // Dynamic imports and CSS URLs use the parent resource as Referer, not the preview document.
  if (preview && relativePath.startsWith('assets/') && !url.searchParams.has(MONITOR_PREVIEW_PARAM)) {
    const target = new URL(url);
    target.searchParams.set(MONITOR_PREVIEW_PARAM, preview.short);
    return new Response(null, { status: 307, headers: { ...NO_STORE, Location: target.toString(), Vary: 'Cookie, Referer' } });
  }
  let response;
  try {
    const theme = preview?.short || (await loadMonitorThemes(env.DB, env.MONITOR_COMPAT_THEME)).effective;
    response = await env.ASSETS.fetch(new Request(`http://monitor-theme/_monitor_theme/${theme}/${relativePath}${url.search}`, {
      method: request.method
    }));
  } catch (error) {
    return error?.message === 'monitorThemeUnavailable'
      ? Response.json({ error: 'monitorThemeUnavailable' }, { status: 503, headers: NO_STORE }) : createNotFoundResponse();
  }
  if (!response.ok) return createNotFoundResponse();
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Cookie, Referer');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.delete('CDN-Cache-Control');
  if (preview && relativePath === 'index.html') {
    headers.delete('Content-Length');
    headers.delete('ETag');
  }
  let body = request.method === 'HEAD' ? null : response.body;
  if (request.method !== 'HEAD' && relativePath === 'index.html') {
    if (preview) body = monitorPreviewHtml(await response.text(), preview.short);
    else if (defaultFrontend) {
      body = (await response.text()).replace(/<head([^>]*)>/i, `<head$1><script>(()=>{const Original=window.WebSocket;window.WebSocket=class extends Original{constructor(url,...args){const target=new URL(url,location.href);if(target.host===location.host&&target.pathname==='/api/ws')target.searchParams.set('monitor_protocol','1');super(target.href,...args)}};const hash=location.hash.match(/^#\\/server\\/([^?]+)/);if(hash)location.replace('/server/'+encodeURIComponent(decodeURIComponent(hash[1])));else if(location.hash.startsWith('#/admin'))location.replace('/admin'+location.hash)})()</script>`);
      headers.delete('Content-Length');
      headers.delete('ETag');
    }
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

async function openMonitorCompatSocket(request, env, url, defaultFrontend) {
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
    const headers = { Upgrade: 'websocket' };
    if (defaultFrontend) {
      const token = monitorCookie(request, 'cfsm_auth') || monitorCookie(request, 'cfsm_theme_preview_auth');
      const auth = request.headers.get('Authorization') || (token ? `Bearer ${token}` : '');
      if (auth) headers.Authorization = auth;
      const receipt = monitorCookie(request, MONITOR_VERIFICATION_COOKIE) || request.headers.get('X-Turnstile-Verified');
      if (receipt) headers['X-Turnstile-Verified'] = receipt;
    }
    return await namespace.get(namespace.idFromName('global')).fetch(defaultFrontend ? MONITOR_VIEWER_LIVE_URL : MONITOR_COMPAT_LIVE_URL, {
      headers
    });
  } catch {
    return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
  }
}

export async function handleMonitorCompat(request, env, url) {
  // Admin previews carry an authenticated document context, never a global theme-selection cookie.
  const preview = await resolveMonitorPreview(request, env, url);
  if (preview?.status) return Response.json({ error: preview.error }, { status: preview.status, headers: NO_STORE });
  const host = env.MONITOR_COMPAT_HOST;
  const exactHost = typeof host === 'string' && host.length <= 253 && MONITOR_DNS_HOSTNAME.test(host) && url.hostname === host.toLowerCase();
  const defaultFrontend = !preview && env.MONITOR_FRONTEND_MODE !== 'legacy';
  const nativePath = monitorCompatThemePath(url.pathname) || /^\/api\/(me|nodes(?:\/[1-9]\d*\/metrics)?|themes\/default\/config|monitor-access)$/.test(url.pathname) || /^\/server\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname);
  const markedSocket = url.pathname === '/api/ws' && url.searchParams.get('monitor_protocol') === '1';
  // The default homepage replaces only native theme routes, never Agent or existing CF API entry points.
  if (defaultFrontend && !nativePath && !markedSocket) return url.pathname.startsWith('/_monitor_theme/') ? createNotFoundResponse() : null;
  if (!preview && !exactHost && (!defaultFrontend || (!nativePath && !markedSocket))) {
    if (defaultFrontend && url.pathname.startsWith('/_monitor_theme/')) return createNotFoundResponse();
    return null;
  }

  // Let the existing CF admin handlers enforce their auth, Turnstile, and terminal checks.
  if (isMonitorAdminRoute(request, url.pathname)) return null;
  if (defaultFrontend && url.pathname === '/api/ws' && !markedSocket && !exactHost) return null;
  if (defaultFrontend) {
    const accessResponse = await handleMonitorAccess(request, env, url);
    if (accessResponse) return accessResponse;
    if (/^\/server\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
      const access = await loadMonitorViewerAccess(request, env);
      if (access.status === 503) return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
      if (access.status !== 200) return access.status === 403 ? serveMonitorAccessGate(request, env) : Response.redirect(new URL('/admin/', url).toString(), 302);
      const id = url.pathname.slice('/server/'.length);
      const row = await env.DB.prepare(`SELECT id FROM servers WHERE id=? AND ${MONITOR_COMPAT_VISIBLE}`).bind(id).first();
      if (!row) return createNotFoundResponse();
      const ids = await getMonitorCompatIds(env.DB, [id]);
      return Response.redirect(new URL(`/node/${ids.get(id)}`, url).toString(), 302);
    }
    if (monitorCompatThemePath(url.pathname) === 'index.html') {
      const access = await loadMonitorViewerAccess(request, env);
      if (access.status === 403) return serveMonitorAccessGate(request, env);
      if (access.status === 503) return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
    }
  }

  const viewerProtocol = defaultFrontend || (preview && env.MONITOR_FRONTEND_MODE !== 'legacy');
  if (preview) {
    const access = viewerProtocol ? await loadMonitorViewerAccess(request, env) : await loadMonitorCompatAccess(env.DB);
    if (access.status !== 200) return Response.json({ error: access.status === 401 ? 'monitorPreviewPrivate' : access.status === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable' }, { status: access.status, headers: NO_STORE });
  }
  const themeResponse = await serveMonitorCompatTheme(request, env, url, preview, defaultFrontend);
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
  if (isLive) return openMonitorCompatSocket(request, env, url, viewerProtocol);

  const { status, siteName, display, authed = false, publicSite } = viewerProtocol ? await loadMonitorViewerAccess(request, env) : await loadMonitorCompatAccess(env.DB);
  if (isMe && viewerProtocol && status === 503) return Response.json({ error: 'Service Unavailable' }, { status, headers: NO_STORE });
  if (!isMe) {
    if (status !== 200) {
      const error = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable';
      return Response.json({ error }, { status, headers: NO_STORE });
    }
    try {
      if (isDefaultConfig) return Response.json((await loadMonitorThemes(env.DB)).configs.default, { headers: NO_STORE });
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
    authed,
    github: false,
    public_page: viewerProtocol ? publicSite === true && status === 200 : status === 200,
    site_name: siteName,
    history_days: 1
  }, { headers: NO_STORE });
}

import { loadMonitorCompatAccess, MONITOR_COMPAT_LIVE_URL } from '../services/monitorCompatAccess.js';
import { createNotFoundResponse } from '../utils/errors.js';
import { loadMonitorCompatSnapshot } from '../services/monitorCompatSnapshot.js';
import { loadMonitorCompatHistory } from '../services/monitorCompatHistory.js';
import { loadMonitorThemes, getMonitorThemeConfig, saveMonitorThemeConfig } from '../services/monitorThemes.js';
import { MONITOR_DNS_HOSTNAME, MONITOR_PREVIEW_PARAM, MONITOR_REVISION_PARAM, findMonitorTheme } from '../shared/monitorThemes.js';
import { resolveMonitorPreview, monitorThemeHtml, monitorResourceRevision } from './monitorThemePreview.js';
import { readMonitorThemeFile, resolveMonitorThemeRelease, validMonitorRevision } from '../services/monitorThemePackages.js';
import { loadMonitorViewerAccess, MONITOR_VIEWER_LIVE_URL, monitorCookie, MONITOR_VERIFICATION_COOKIE } from '../services/monitorViewerAccess.js';
import { handleMonitorAccess, serveMonitorAccessGate } from './monitorAccess.js';
import { monitorThemeMutationAccess } from './monitorThemeUpload.js';
import { getMonitorCompatIds, MONITOR_COMPAT_VISIBLE } from '../database/monitorCompatIds.js';

export { loadMonitorCompatAccess };
const NO_STORE = { 'Cache-Control': 'no-store' };
const ADMIN_GET = new Set(['/admin', '/admin/', '/api/config', '/theme']);
const ADMIN_POST = new Set(['/admin/api', '/updateDatabase', '/clearHistory']);
function adminRoute(request, pathname) {
  return request.method === 'GET' && (ADMIN_GET.has(pathname) || /^\/admin\/api\/terminal\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/ws$/.test(pathname)) ||
    request.method === 'POST' && ADMIN_POST.has(pathname);
}

function themePath(pathname) {
  if (pathname.split('/').includes('api')) return null;
  if (/^\/(api|admin|_monitor_theme|__do)(\/|$)/.test(pathname) || /^\/(update|updateDatabase|clearHistory|theme)$/.test(pathname)) return null;
  if (/^\/(static|files|mikus|os-icons)(\/|$)/.test(pathname) || /^\/(install[^/]*|uninstall[^/]*|cf-server-monitor\.ps1|manifest\.json|dashboard\.html)$/.test(pathname)) return null;
  try {
    const decoded = decodeURIComponent(pathname.slice(1));
    if (!decoded) return 'index.html';
    if (decoded.split('/').includes('api') || /^(api|admin|_monitor_theme|__do|static|files|mikus|os-icons)(\/|$)/.test(decoded)) return null;
    if (/^(update|updateDatabase|clearHistory|theme|install[^/]*|uninstall[^/]*|cf-server-monitor\.ps1|manifest\.json|dashboard\.html)$/.test(decoded)) return null;
    if (/[\\:\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return decoded;
  } catch { return null; }
}

async function serveTheme(request, env, url, preview, defaultFrontend) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const path = themePath(url.pathname);
  if (!path) return null;
  if (!env.ASSETS && !env.MONITOR_THEME_BUCKET) return createNotFoundResponse();
  const revision = preview?.revision || monitorResourceRevision(request, url);
  if (revision && !validMonitorRevision(revision)) return Response.json({ error: 'monitorThemeInvalid' }, { status: 400, headers: NO_STORE });
  const resource = /\.[^/]+$/.test(path) && path !== 'index.html';
  if (resource && ((preview && !url.searchParams.has(MONITOR_PREVIEW_PARAM)) || (revision && !url.searchParams.has(MONITOR_REVISION_PARAM)))) {
    const target = new URL(url);
    if (preview) target.searchParams.set(MONITOR_PREVIEW_PARAM, preview.short);
    if (revision) target.searchParams.set(MONITOR_REVISION_PARAM, revision);
    return new Response(null, { status: 307, headers: { ...NO_STORE, Location: target.toString(), Vary: 'Cookie, Referer' } });
  }
  let response, release, index = path === 'index.html';
  try {
    const selected = preview?.short || (await loadMonitorThemes(env.DB, env.MONITOR_COMPAT_THEME)).effective;
    release = await resolveMonitorThemeRelease(env, selected, revision);
    if (!release) return createNotFoundResponse();
    if (!defaultFrontend && !preview && release.builtin && (url.pathname === '/index.html' || !/^(index\.html|node\/[1-9]\d*|assets\/.+|favicon\.[^/]+|apple-touch-icon\.png)$/.test(path))) return createNotFoundResponse();
    const builtinPage = release.builtin && /^node\/[1-9]\d*$/.test(path);
    if (builtinPage) index = true;
    response = await readMonitorThemeFile(env, release.manifest.short, builtinPage ? 'index.html' : path, release.revision, request.method, url.search);
    if (!response && !resource && !index) { index = true; response = await readMonitorThemeFile(env, release.manifest.short, 'index.html', release.revision, request.method); }
    if (!response && index && !release.builtin && !preview && !revision) {
      release = await resolveMonitorThemeRelease(env, 'default', 'builtin-default');
      response = await readMonitorThemeFile(env, 'default', 'index.html', 'builtin-default', request.method);
    }
  } catch (error) {
    if (!preview && !revision && !resource && error?.message === 'monitorThemeStorageUnavailable') {
      release = await resolveMonitorThemeRelease(env, 'default', 'builtin-default');
      response = await readMonitorThemeFile(env, 'default', 'index.html', 'builtin-default', request.method); index = true;
    } else return Response.json({ error: 'monitorThemeUnavailable' }, { status: 503, headers: NO_STORE });
  }
  if (!response) {
    if (/^(flags\/|favicon\.)/.test(path) && !preview && !revision && env.ASSETS) return null;
    return createNotFoundResponse();
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store'); headers.set('Vary', 'Cookie, Referer'); headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff'); headers.set('X-Frame-Options', 'DENY'); headers.delete('CDN-Cache-Control');
  let body = request.method === 'HEAD' ? null : response.body;
  if (index) {
    headers.delete('Content-Length'); headers.delete('ETag');
    if (request.method !== 'HEAD' && (preview || defaultFrontend)) body = monitorThemeHtml(await response.text(), {
      short: release.manifest.short, revision: release.revision, preview: !!preview, viewer: env.MONITOR_FRONTEND_MODE !== 'legacy'
    });
  }
  return new Response(body, { status: response.status, headers });
}

async function openSocket(request, env, url, viewer) {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) return Response.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE });
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket upgrade request', { status: 426, headers: NO_STORE });
  try {
    const headers = { Upgrade: 'websocket' };
    if (viewer) {
      const token = monitorCookie(request, 'cfsm_auth') || monitorCookie(request, 'cfsm_theme_preview_auth');
      const auth = request.headers.get('Authorization') || (token ? `Bearer ${token}` : '');
      if (auth) headers.Authorization = auth;
      const receipt = monitorCookie(request, MONITOR_VERIFICATION_COOKIE) || request.headers.get('X-Turnstile-Verified');
      if (receipt) headers['X-Turnstile-Verified'] = receipt;
    }
    const ns = env.METRICS_BROADCASTER;
    return await ns.get(ns.idFromName('global')).fetch(viewer ? MONITOR_VIEWER_LIVE_URL : MONITOR_COMPAT_LIVE_URL, { headers });
  } catch { return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE }); }
}

export async function handleMonitorCompat(request, env, url) {
  const preview = await resolveMonitorPreview(request, env, url);
  if (preview?.status) return Response.json({ error: preview.error }, { status: preview.status, headers: NO_STORE });
  const host = env.MONITOR_COMPAT_HOST;
  const exactHost = typeof host === 'string' && host.length <= 253 && MONITOR_DNS_HOSTNAME.test(host) && url.hostname === host.toLowerCase();
  const defaultFrontend = !preview && env.MONITOR_FRONTEND_MODE !== 'legacy';
  const nativePath = themePath(url.pathname) || /^\/api\/(me|nodes(?:\/[1-9]\d*\/metrics)?|themes\/[A-Za-z0-9_-]{1,128}\/config|monitor-access)$/.test(url.pathname);
  const marked = url.pathname === '/api/ws' && url.searchParams.get('monitor_protocol') === '1';
  if (defaultFrontend && !nativePath && !marked) return url.pathname.startsWith('/_monitor_theme/') ? createNotFoundResponse() : null;
  if (!preview && !exactHost && (!defaultFrontend || (!nativePath && !marked))) return null;
  if (adminRoute(request, url.pathname)) return null;
  const viewer = defaultFrontend || (preview && env.MONITOR_FRONTEND_MODE !== 'legacy');
  if (defaultFrontend) {
    const gate = await handleMonitorAccess(request, env, url);
    if (gate) return gate;
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
    if (themePath(url.pathname) && (!/\.[^/]+$/.test(url.pathname) || themePath(url.pathname) === 'index.html')) {
      const access = await loadMonitorViewerAccess(request, env);
      if (access.status === 403) return serveMonitorAccessGate(request, env);
      if (access.status === 503) return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE });
    }
  }
  if (preview) {
    const access = viewer ? await loadMonitorViewerAccess(request, env) : await loadMonitorCompatAccess(env.DB);
    if (access.status !== 200) return Response.json({ error: access.status === 401 ? 'monitorPreviewPrivate' : access.status === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable' }, { status: access.status, headers: NO_STORE });
  }
  const page = await serveTheme(request, env, url, preview, defaultFrontend);
  if (page) return page;
  const isMe = url.pathname === '/api/me', isNodes = url.pathname === '/api/nodes', isLive = url.pathname === '/api/ws';
  const configShort = /^\/api\/themes\/([A-Za-z0-9_-]{1,128})\/config$/.exec(url.pathname)?.[1];
  const historyId = Number(/^\/api\/nodes\/([1-9]\d*)\/metrics$/.exec(url.pathname)?.[1]);
  const isHistory = Number.isSafeInteger(historyId);
  if (!isMe && !isNodes && !isLive && !configShort && !isHistory) return createNotFoundResponse();
  if (configShort && !viewer && !findMonitorTheme(configShort)) return createNotFoundResponse();
  if (configShort && request.method === 'PUT') {
    if (!viewer) return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { ...NO_STORE, Allow: 'GET' } });
    const status = await monitorThemeMutationAccess(request, env);
    if (status !== 200) return Response.json({ error: 'monitorThemeAccessDenied' }, { status, headers: NO_STORE });
    try {
      const reader = request.body?.getReader(), chunks = []; let size = 0;
      if (!reader) throw new Error();
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 64 * 1024) { await reader.cancel(); return Response.json({ error: 'monitorThemeInvalid' }, { status: 413, headers: NO_STORE }); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await saveMonitorThemeConfig(env.DB, configShort, JSON.parse(text));
      return new Response(null, { status: 204, headers: NO_STORE });
    } catch (error) { return Response.json({ error: error?.code ? error.message : 'monitorThemeInvalid' }, { status: error?.code || 400, headers: NO_STORE }); }
  }
  if (request.method !== 'GET') return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'GET' } });
  if (isLive) return openSocket(request, env, url, viewer);
  const { status, siteName, display, authed = false, publicSite } = viewer ? await loadMonitorViewerAccess(request, env) : await loadMonitorCompatAccess(env.DB);
  if (isMe && viewer && status === 503) return Response.json({ error: 'Service Unavailable' }, { status, headers: NO_STORE });
  if (!isMe) {
    if (status !== 200) return Response.json({ error: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable' }, { status, headers: NO_STORE });
    try {
      if (configShort) {
        if (configShort === 'default') await loadMonitorThemes(env.DB);
        return Response.json(await getMonitorThemeConfig(env.DB, configShort), { headers: NO_STORE });
      }
      if (isNodes) return Response.json(await loadMonitorCompatSnapshot(env, { display }), { headers: NO_STORE });
      const result = await loadMonitorCompatHistory(env.DB, historyId, url.searchParams);
      if (result === null) return createNotFoundResponse();
      if (result === false) return Response.json({ error: 'Invalid history query' }, { status: 400, headers: NO_STORE });
      return Response.json(result, { headers: NO_STORE });
    } catch { return Response.json({ error: 'Service Unavailable' }, { status: 503, headers: NO_STORE }); }
  }
  return Response.json({ authed, github: false, public_page: viewer ? publicSite === true && status === 200 : status === 200, site_name: siteName, history_days: 1 }, { headers: NO_STORE });
}

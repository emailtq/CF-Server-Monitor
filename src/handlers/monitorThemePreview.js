import { checkPreviewAuth } from './frontend.js';
import { MONITOR_PREVIEW_PARAM, findMonitorTheme } from '../shared/monitorThemes.js';

// The original SPA replaces its URL when navigating. Preserve preview transport context without changing the release files.
export function monitorPreviewHtml(html, short) {
  const script = `<script>(() => {
    const key = ${JSON.stringify(MONITOR_PREVIEW_PARAM)}, theme = ${JSON.stringify(short)};
    const contextual = url => {
      const target = new URL(url, location.href);
      if (target.origin === location.origin) target.searchParams.set(key, theme);
      return target.href;
    };
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name].bind(history);
      history[name] = (state, title, url) => original(state, title, url == null ? url : contextual(url));
    }
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url, ...args) {
        const target = new URL(url, location.href);
        if (target.host === location.host && target.pathname === '/api/ws') target.searchParams.set(key, theme);
        super(target.href, ...args);
      }
    };
  })()</script>`;
  return html.replace(/<head([^>]*)>/i, `<head$1>${script}`);
}

export async function resolveMonitorPreview(request, env, url) {
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname === '/api/config' || url.pathname === '/theme') return null;
  let short;
  if (url.searchParams.has(MONITOR_PREVIEW_PARAM)) short = url.searchParams.get(MONITOR_PREVIEW_PARAM);
  else {
    try {
      const referrer = new URL(request.headers.get('Referer'));
      if (referrer.origin === url.origin) short = referrer.searchParams.get(MONITOR_PREVIEW_PARAM);
    } catch { /* No same-origin preview document. */ }
  }
  if (short == null) return null;
  if (!findMonitorTheme(short)) return { status: 400, error: 'monitorThemeInvalid' };
  // Read only the JWT authority required by the existing preview verifier; do not initialize secrets or load credentials.
  if (!request.headers.get('Cookie')?.includes('cfsm_theme_preview_auth=')) return { status: 401, error: 'monitorPreviewLogin' };
  try {
    const { success, results } = await env.DB.prepare("SELECT key, CASE WHEN key='site_options' THEN value -> '$.jwt_secret' ELSE json_quote(value) END AS jwt_secret FROM settings WHERE key IN ('site_options','jwt_secret')").all();
    if (!success) throw new Error();
    const rows = Object.fromEntries(results.map(row => [row.key, row.jwt_secret]));
    const jwtSecret = rows.site_options == null ? rows.jwt_secret : rows.site_options;
    if (!await checkPreviewAuth(request, env, { jwt_secret: jwtSecret == null ? undefined : JSON.parse(jwtSecret) })) return { status: 401, error: 'monitorPreviewLogin' };
    return { short };
  } catch {
    return { status: 503, error: 'monitorThemeUnavailable' };
  }
}

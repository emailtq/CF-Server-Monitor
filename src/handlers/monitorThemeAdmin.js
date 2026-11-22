import { MONITOR_THEMES, MONITOR_PREVIEW_PARAM, MONITOR_DNS_HOSTNAME, findMonitorTheme } from '../shared/monitorThemes.js';
import { loadMonitorThemes, selectMonitorTheme, saveMonitorThemeConfig } from '../services/monitorThemes.js';
import { loadMonitorCompatAccess } from '../services/monitorCompatAccess.js';
import { loadMonitorViewerAccess } from '../services/monitorViewerAccess.js';

export async function handleMonitorThemeAdmin({ request, env, data, previewAuthCookie }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    await loadMonitorThemes(env.DB, env.MONITOR_COMPAT_THEME);
    if (data.action === 'select_monitor_theme') await selectMonitorTheme(env.DB, data.theme);
    if (data.action === 'save_monitor_theme_config') await saveMonitorThemeConfig(env.DB, data.theme, data.config);
    const state = await loadMonitorThemes(env.DB, env.MONITOR_COMPAT_THEME);
    const defaultFrontend = env.MONITOR_FRONTEND_MODE !== 'legacy';
    const access = defaultFrontend ? await loadMonitorViewerAccess(request, env) : await loadMonitorCompatAccess(env.DB);
    const hostname = typeof env.MONITOR_COMPAT_HOST === 'string' && env.MONITOR_COMPAT_HOST.length <= 253 && MONITOR_DNS_HOSTNAME.test(env.MONITOR_COMPAT_HOST)
      ? env.MONITOR_COMPAT_HOST.toLowerCase() : null;
    if (data.action === 'start_monitor_theme_preview') {
      if (!findMonitorTheme(data.theme)) return Response.json({ error: 'monitorThemeInvalid' }, { status: 400, headers });
      if (access.status !== 200) return Response.json({ error: access.status === 401 ? 'monitorPreviewPrivate' : access.status === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable' }, { status: access.status === 503 ? 503 : 409, headers });
      const url = new URL('/', request.url);
      url.searchParams.set(MONITOR_PREVIEW_PARAM, data.theme);
      if (previewAuthCookie) headers['Set-Cookie'] = previewAuthCookie;
      return Response.json({ success: true, preview_url: url.toString() }, { headers });
    }
    return Response.json({ success: true, themes: MONITOR_THEMES, ...state, hostname, defaultFrontend, previewStatus: access.status }, { headers });
  } catch (error) {
    const invalid = error?.message === 'monitorThemeInvalid';
    return Response.json({ error: invalid ? 'monitorThemeInvalid' : 'monitorThemeUnavailable' }, { status: invalid ? 400 : 503, headers });
  }
}

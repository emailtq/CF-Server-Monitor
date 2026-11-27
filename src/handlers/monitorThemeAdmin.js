import { monitorBuiltinRevision } from "../shared/monitorThemes.js";
import { MONITOR_PREVIEW_PARAM, MONITOR_DNS_HOSTNAME } from '../shared/monitorThemes.js';
import { loadMonitorThemes, selectMonitorTheme, saveMonitorThemeConfig } from '../services/monitorThemes.js';
import { loadMonitorCompatAccess } from '../services/monitorCompatAccess.js';
import { loadMonitorViewerAccess } from '../services/monitorViewerAccess.js';
import { installMonitorRepository } from '../services/monitorThemeRepository.js';
import { loadMonitorPackageRegistry, loadMonitorRelease, removeMonitorTheme, readMonitorThemeThumbnail } from '../services/monitorThemePackages.js';
import { monitorThemeMutationAccess, monitorThemeMutationAuthorization } from './monitorThemeUpload.js';
import { AppError } from '../utils/errors.js';

export async function handleMonitorThemeAdmin({ request, env, data, previewAuthCookie }) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const initial = await loadMonitorThemes(env.DB, env.MONITOR_COMPAT_THEME);
    let update;
    if (data.action === 'get_monitor_theme_thumbnail') {
      const status = await monitorThemeMutationAccess(request, env);
      if (status !== 200) return Response.json({error:'monitorThemeAccessDenied'}, {status,headers});
      if (!initial.themes.some(theme => theme.short === data.theme)) throw new AppError('monitorThemeInvalid',400);
      const image = await readMonitorThemeThumbnail(env, data.theme);
      return image ? new Response(image.body, {headers:{...headers,'Content-Type':'image/png'}}) : new Response(null,{status:404,headers});
    }
    if (['install_monitor_theme', 'update_monitor_theme', 'delete_monitor_theme'].includes(data.action)) {
      const {status,publisher} = await monitorThemeMutationAuthorization(request, env);
      if (status !== 200) return Response.json({ error: 'monitorThemeAccessDenied' }, { status, headers });
      if (data.action === 'install_monitor_theme') await installMonitorRepository(env, data.repository,undefined,undefined,undefined,publisher);
      if (data.action === 'update_monitor_theme') {
        const { registry } = await loadMonitorPackageRegistry(env.DB);
        const revision = Object.hasOwn(registry, data.theme) ? registry[data.theme] : null;
        const release = await loadMonitorRelease(env.DB, revision || monitorBuiltinRevision(data.theme));
        if (!release) throw new AppError('monitorThemeUnavailable', 503);
        update = await installMonitorRepository(env, release.repository ? `https://github.com/${release.repository}` : release.manifest.url, data.theme, revision, release.manifest.version,publisher);
      }
      if (data.action === 'delete_monitor_theme') await removeMonitorTheme(env, data.theme);
    }
    if (data.action === 'select_monitor_theme') await selectMonitorTheme(env.DB, data.theme);
    if (data.action === 'save_monitor_theme_config') await saveMonitorThemeConfig(env.DB, data.theme, data.config);
    const state = await loadMonitorThemes(env.DB, env.MONITOR_COMPAT_THEME);
    const defaultFrontend = env.MONITOR_FRONTEND_MODE !== 'legacy';
    const access = defaultFrontend ? await loadMonitorViewerAccess(request, env) : await loadMonitorCompatAccess(env.DB);
    const hostname = typeof env.MONITOR_COMPAT_HOST === 'string' && env.MONITOR_COMPAT_HOST.length <= 253 && MONITOR_DNS_HOSTNAME.test(env.MONITOR_COMPAT_HOST)
      ? env.MONITOR_COMPAT_HOST.toLowerCase() : null;
    if (data.action === 'start_monitor_theme_preview') {
      const theme = state.themes.find(item => item.short === data.theme);
      if (!theme) return Response.json({ error: 'monitorThemeInvalid' }, { status: 400, headers });
      if (access.status !== 200) return Response.json({ error: access.status === 401 ? 'monitorPreviewPrivate' : access.status === 403 ? 'monitorPreviewTurnstile' : 'monitorThemeUnavailable' }, { status: access.status === 503 ? 503 : 409, headers });
      const url = new URL('/', request.url);
      url.searchParams.set(MONITOR_PREVIEW_PARAM, data.theme);
      url.searchParams.set('monitor_revision', theme.revision);
      if (previewAuthCookie) headers['Set-Cookie'] = previewAuthCookie;
      return Response.json({ success: true, preview_url: url.toString() }, { headers });
    }
    return Response.json({ success: true, ...state, ...(update ? {updated:update.updated,version:update.version} : {}), hostname, defaultFrontend, runtimeStorage: !!env.DB, previewStatus: access.status }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof AppError ? error.message : 'monitorThemeUnavailable' }, { status: error instanceof AppError ? error.code : 503, headers });
  }
}

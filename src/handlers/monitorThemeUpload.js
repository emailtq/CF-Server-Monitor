import { checkAuth } from '../middleware/auth.js';
import { loadMonitorViewerPolicy, authorizeMonitorViewer } from '../services/monitorViewerAccess.js';
import { installMonitorTheme } from '../services/monitorThemePackages.js';
import { MONITOR_ARCHIVE_LIMIT } from '../shared/monitorThemeArchive.js';
import { AppError } from '../utils/errors.js';

export async function monitorThemeMutationAccess(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return 403;
  const policy = await loadMonitorViewerPolicy(env);
  if (policy.status === 503) return 503;
  if (!await checkAuth(request, env, policy)) return 401;
  return (await authorizeMonitorViewer(request, env, policy)).status;
}

export async function handleMonitorThemeUpload(request, env, url) {
  if (url.pathname !== '/admin/api/monitor-themes/upload') return null;
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
  const status = await monitorThemeMutationAccess(request, env);
  if (status !== 200) return Response.json({ error: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'monitorThemeUnavailable' }, { status, headers });
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MONITOR_ARCHIVE_LIMIT)) return Response.json({ error: 'monitorThemeArchiveTooLarge' }, { status: 413, headers });
  try {
    const theme = await installMonitorTheme(env, request.body);
    return Response.json({ success: true, theme }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof AppError ? error.message : 'monitorThemeUnavailable' }, { status: error instanceof AppError ? error.code : 503, headers });
  }
}

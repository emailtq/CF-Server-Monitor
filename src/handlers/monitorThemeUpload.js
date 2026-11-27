import { checkAuth, getTerminalJwtPrincipal } from '../middleware/auth.js';
import { loadMonitorViewerPolicy, authorizeMonitorViewer } from '../services/monitorViewerAccess.js';
import { installMonitorTheme } from '../services/monitorThemePackages.js';
import { MONITOR_ARCHIVE_LIMIT } from '../shared/monitorThemeArchive.js';
import { AppError } from '../utils/errors.js';

export async function monitorThemeMutationAccess(request, env) {
  return (await monitorThemeMutationAuthorization(request,env)).status;
}

export async function monitorThemeMutationAuthorization(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return {status:403};
  const policy = await loadMonitorViewerPolicy(env);
  if (policy.status === 503) return {status:503};
  if (!await checkAuth(request, env, policy)) return {status:401};
  const access=await authorizeMonitorViewer(request,env,policy);
  if(!access.authed)return {status:401};
  if(access.status!==200)return {status:access.status};
  const owner=await getTerminalJwtPrincipal(request,env,policy);
  return owner?{status:200,publisher:{...owner,authority:policy.jwt_secret}}:{status:401};
}

export async function handleMonitorThemeUpload(request, env, url) {
  if (url.pathname !== '/admin/api/monitor-themes/upload') return null;
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
  const {status,publisher} = await monitorThemeMutationAuthorization(request, env);
  if (status !== 200) return Response.json({ error: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'monitorThemeUnavailable' }, { status, headers });
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MONITOR_ARCHIVE_LIMIT)) return Response.json({ error: 'monitorThemeArchiveTooLarge' }, { status: 413, headers });
  try {
    const theme = await installMonitorTheme(env, request.body, {publisher});
    return Response.json({ success: true, theme }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof AppError ? error.message : 'monitorThemeUnavailable' }, { status: error instanceof AppError ? error.code : 503, headers });
  }
}

import { loadMonitorCompatSnapshot } from '../services/monitorCompatSnapshot.js';
import { loadMonitorViewerAccess } from '../services/monitorViewerAccess.js';
import { loadMonitorStandardHistory } from '../services/monitorCompatHistory.js';
import { stringifyMonitor } from '../services/monitorProjection.js';

const headers = { 'Content-Type':'application/json', 'Cache-Control':'no-store' };
const failure = (text,status,extra={}) => new Response(text,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',...extra}});
export async function handleMonitorApi(request, env, url) {
  const historyId = /^\/api\/nodes\/([1-9]\d*)\/metrics$/.exec(url.pathname)?.[1];
  if (!['/api/me','/api/nodes'].includes(url.pathname) && !historyId) return null;
  if (request.method !== 'GET') return failure('Method Not Allowed',405,{Allow:'GET'});
  const access = await loadMonitorViewerAccess(request,env);
  if (url.pathname === '/api/me' && access.status === 503) return Response.json({error:'Service Unavailable'},{status:503,headers});
  if (url.pathname === '/api/me' && access.status !== 503) return Response.json({authed:access.authed === true,github:false,public_page:access.publicSite === true && access.status === 200,
    site_name:access.siteName,site:'',history_days:access.authed ? 30 : 1},{headers});
  if (access.status !== 200) return failure(access.status === 401 ? 'Unauthorized' : access.status === 403 ? 'Forbidden' : 'Service Unavailable',access.status);
  try {
    const result = historyId ? await loadMonitorStandardHistory(env.DB,Number(historyId),url.searchParams,{accessDays:access.authed ? 30 : 1}) :
      await loadMonitorCompatSnapshot(env,{display:access.display,standard:true});
    if (result === null) return failure('Not Found',404);
    if (result === false) return failure('Invalid history query',400);
    return new Response(stringifyMonitor(result),{headers});
  } catch { return failure('Service Unavailable',503); }
}

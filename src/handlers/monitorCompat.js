import { DEFAULT_SITE_TITLE } from '../utils/config.js';
import { createNotFoundResponse } from '../utils/errors.js';
import { loadMonitorCompatSnapshot } from '../services/monitorCompatSnapshot.js';
import { loadMonitorCompatHistory } from '../services/monitorCompatHistory.js';

const DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function loadMonitorCompatAccess(db) {
  const unavailable = { status: 503, siteName: DEFAULT_SITE_TITLE };
  try {
    // Project only public fields: the legacy readers may fall back to stale/default settings or write a JWT secret.
    const { success, results } = await db.prepare(`
      SELECT key,
        CASE WHEN key IN ('site_options', 'appearance_options') THEN json_type(value) END AS group_type,
        CASE WHEN key = 'site_options' THEN value -> '$.is_public' END AS is_public,
        CASE WHEN key = 'site_options' THEN value -> '$.turnstile_enabled' END AS turnstile_enabled,
        CASE WHEN key = 'site_options' THEN value -> '$.show_price' END AS show_price,
        CASE WHEN key = 'site_options' THEN value -> '$.show_expire' END AS show_expire,
        CASE WHEN key = 'site_options' THEN value -> '$.show_tf' END AS show_tf,
        CASE WHEN key = 'appearance_options' THEN value -> '$.site_title' END AS site_title,
        CASE WHEN key NOT IN ('site_options', 'appearance_options') THEN value END AS legacy_value
      FROM settings WHERE key IN ('site_options', 'appearance_options', 'is_public', 'turnstile_enabled',
        'site_title', 'show_price', 'show_expire', 'show_tf')
    `).all();
    if (!success) return unavailable;

    const rows = Object.fromEntries(results.map(row => [row.key, row]));
    if ((rows.site_options && rows.site_options.group_type !== 'object') ||
        (rows.appearance_options && rows.appearance_options.group_type !== 'object')) return unavailable;

    const setting = (group, key) => {
      const json = rows[group]?.[key];
      return json == null ? rows[key]?.legacy_value : JSON.parse(json);
    };
    const title = setting('appearance_options', 'site_title');
    const siteName = typeof title === 'string' && title ? title : DEFAULT_SITE_TITLE;
    const turnstile = setting('site_options', 'turnstile_enabled');
    if (turnstile === 'true' || turnstile === true) return { status: 403, siteName };
    if (turnstile !== undefined && turnstile !== 'false' && turnstile !== false) return unavailable;

    if (setting('site_options', 'is_public') !== 'true') return { status: 401, siteName };
    const enabled = key => [undefined, true, 'true'].includes(setting('site_options', key));
    return {
      status: 200,
      siteName,
      display: { showPrice: enabled('show_price'), showExpire: enabled('show_expire'), showTraffic: enabled('show_tf') }
    };
  } catch {
    return unavailable;
  }
}

export async function handleMonitorCompat(request, env, url) {
  const host = env.MONITOR_COMPAT_HOST;
  if (typeof host !== 'string' || host.length > 253 || !DNS_HOSTNAME.test(host) ||
      url.hostname !== host.toLowerCase()) return null;

  const isMe = url.pathname === '/api/me';
  const isNodes = url.pathname === '/api/nodes';
  const isDefaultConfig = url.pathname === '/api/themes/default/config';
  const historyId = Number(/^\/api\/nodes\/([1-9]\d*)\/metrics$/.exec(url.pathname)?.[1]);
  const isHistory = Number.isSafeInteger(historyId);
  if (!isMe && !isNodes && !isDefaultConfig && !isHistory) return createNotFoundResponse();
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'GET' } });
  }

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

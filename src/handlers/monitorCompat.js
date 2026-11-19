import { DEFAULT_SITE_TITLE } from '../utils/config.js';
import { createNotFoundResponse } from '../utils/errors.js';

const DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export async function loadMonitorCompatAccess(db) {
  const unavailable = { status: 503, siteName: DEFAULT_SITE_TITLE };
  try {
    // Project only public fields: the legacy readers may fall back to stale/default settings or write a JWT secret.
    const { success, results } = await db.prepare(`
      SELECT key,
        CASE WHEN key IN ('site_options', 'appearance_options') THEN json_type(value) END AS group_type,
        CASE WHEN key = 'site_options' THEN value -> '$.is_public' END AS is_public,
        CASE WHEN key = 'site_options' THEN value -> '$.turnstile_enabled' END AS turnstile_enabled,
        CASE WHEN key = 'appearance_options' THEN value -> '$.site_title' END AS site_title,
        CASE WHEN key IN ('is_public', 'turnstile_enabled', 'site_title') THEN value END AS legacy_value
      FROM settings WHERE key IN ('site_options', 'appearance_options', 'is_public', 'turnstile_enabled', 'site_title')
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

    const isPublic = setting('site_options', 'is_public') === 'true';
    return { status: isPublic ? 200 : 401, siteName };
  } catch {
    return unavailable;
  }
}

export async function handleMonitorCompat(request, env, url) {
  const host = env.MONITOR_COMPAT_HOST;
  if (typeof host !== 'string' || host.length > 253 || !DNS_HOSTNAME.test(host) ||
      url.hostname !== host.toLowerCase()) return null;

  if (url.pathname !== '/api/me') return createNotFoundResponse();
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers: { Allow: 'GET' } });
  }

  const { status, siteName } = await loadMonitorCompatAccess(env.DB);
  return Response.json({
    authed: false,
    github: false,
    public_page: status === 200,
    site_name: siteName,
    history_days: 1
  }, { headers: { 'Cache-Control': 'no-store' } });
}

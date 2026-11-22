import { DEFAULT_SITE_TITLE } from '../utils/config.js';

export const MONITOR_COMPAT_LIVE_URL = 'https://metrics.internal/monitor-compat-live';

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
    if (turnstile !== undefined && !['true', true, 'false', false].includes(turnstile)) return unavailable;
    const enabled = key => [undefined, true, 'true'].includes(setting('site_options', key));
    const publicSite = setting('site_options', 'is_public') === 'true';
    const turnstileEnabled = turnstile === 'true' || turnstile === true;
    return {
      status: turnstileEnabled ? 403 : publicSite ? 200 : 401,
      siteName, publicSite, turnstileEnabled,
      display: { showPrice: enabled('show_price'), showExpire: enabled('show_expire'), showTraffic: enabled('show_tf') }
    };
  } catch {
    return unavailable;
  }
}

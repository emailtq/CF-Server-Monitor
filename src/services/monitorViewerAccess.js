import { loadMonitorCompatAccess } from './monitorCompatAccess.js';
import { checkAuth, getTerminalJwtPrincipal } from '../middleware/auth.js';
import { decryptTurnstileData } from '../middleware/turnstile.js';
import { isValidJwtSecret } from '../utils/settings.js';

export const MONITOR_VIEWER_LIVE_URL = 'https://metrics.internal/monitor-viewer-live';
export const MONITOR_VERIFICATION_COOKIE = 'cfsm_monitor_verified';

export function monitorCookie(request, name) {
  const part = (request.headers.get('Cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='));
  try { return part ? decodeURIComponent(part.slice(name.length + 1)) : ''; } catch { return ''; }
}

export async function loadMonitorViewerPolicy(env) {
  const policy = await loadMonitorCompatAccess(env.DB);
  if (policy.status === 503) return policy;
  try {
    const { success, results } = await env.DB.prepare("SELECT key, CASE WHEN key='site_options' THEN value -> '$.jwt_secret' ELSE json_quote(value) END AS jwt_secret FROM settings WHERE key IN ('site_options','jwt_secret')").all();
    if (!success) throw new Error();
    const rows = Object.fromEntries(results.map(row => [row.key, row.jwt_secret]));
    const encoded = rows.site_options == null ? rows.jwt_secret : rows.site_options;
    return { ...policy, jwt_secret: encoded == null ? undefined : JSON.parse(encoded) };
  } catch { return { status: 503, siteName: policy.siteName }; }
}

export async function authorizeMonitorViewer(request, env, policy) {
  if (policy.status === 503) return { status: 503, siteName: policy.siteName, authed: false };
  const previewToken = monitorCookie(request, 'cfsm_theme_preview_auth');
  const headers = new Headers(request.headers);
  if (previewToken && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${previewToken}`);
  let authed = await checkAuth({ headers }, env, policy);
  if (authed) {
    // Reuse CF logout tombstones without creating a terminal authorization or extending its lease.
    const principal = await getTerminalJwtPrincipal({headers},env,policy);
    try {
      const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='terminal_auth_sessions'").first();
      const session = table && principal ? await env.DB.prepare('SELECT expires_at,revoked_at FROM terminal_auth_sessions WHERE jti=?').bind(principal.jti).first() : null;
      if (!principal || (session && (session.revoked_at !== null || session.expires_at !== principal.exp))) authed = false;
    } catch { return {...policy,status:503,authed:false}; }
  }
  if (!policy.publicSite && !authed) return { ...policy, status: 401, authed };
  if (policy.turnstileEnabled) {
    if (!isValidJwtSecret(policy.jwt_secret)) return { ...policy, status: 503, authed };
    const encoded = monitorCookie(request, MONITOR_VERIFICATION_COOKIE) || request.headers.get('X-Turnstile-Verified');
    const receipt = encoded && await decryptTurnstileData(encoded, env, policy);
    if (!receipt || receipt.verified !== true || !Number.isSafeInteger(receipt.expires) || receipt.expires <= Date.now() / 1000) return { ...policy, status: 403, authed };
  }
  return { ...policy, status: 200, authed };
}

export async function loadMonitorViewerAccess(request, env) {
  const policy = await loadMonitorCompatAccess(env.DB);
  // Keep anonymous unchallenged reads free of authority/credential projections.
  if (policy.status === 200 && !request.headers.get('Authorization') && !monitorCookie(request, 'cfsm_auth') && !monitorCookie(request, 'cfsm_theme_preview_auth')) return { ...policy, authed: false };
  return authorizeMonitorViewer(request, env, await loadMonitorViewerPolicy(env));
}

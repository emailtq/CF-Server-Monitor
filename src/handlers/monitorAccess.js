import { verifyTurnstileToken } from '../utils/common.js';
import { encryptTurnstileData } from '../middleware/turnstile.js';
import { isValidJwtSecret } from '../utils/settings.js';
import { MONITOR_VERIFICATION_COOKIE } from '../services/monitorViewerAccess.js';

const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'text/html;charset=UTF-8', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function verificationSettings(env) {
  const { success, results } = await env.DB.prepare(`SELECT key,
    CASE WHEN key='site_options' THEN json_type(value) END AS group_type,
    CASE WHEN key='site_options' THEN value ->> '$.jwt_secret' END AS jwt_secret,
    CASE WHEN key='site_options' THEN value ->> '$.turnstile_enabled' END AS enabled,
    CASE WHEN key='site_options' THEN value ->> '$.turnstile_secret_key' END AS secret,
    CASE WHEN key='site_options' THEN value ->> '$.turnstile_site_key' END AS site_key,
    CASE WHEN key!='site_options' THEN value END AS legacy_value
    FROM settings WHERE key IN ('site_options','jwt_secret','turnstile_enabled','turnstile_secret_key','turnstile_site_key')`).all();
  if (!success) throw new Error();
  const rows = Object.fromEntries(results.map(row => [row.key, row]));
  if (rows.site_options && rows.site_options.group_type !== 'object') throw new Error();
  const field = (name, legacy) => rows.site_options?.[name] ?? rows[legacy]?.legacy_value;
  return { jwt_secret: field('jwt_secret', 'jwt_secret'), enabled: field('enabled', 'turnstile_enabled'),
    secret: field('secret', 'turnstile_secret_key'), site_key: field('site_key', 'turnstile_site_key') };
}

export async function serveMonitorAccessGate(request, env) {
  try {
    const row = await verificationSettings(env);
    if (!row?.site_key) throw new Error();
    const title = escape('访问验证 · Verify access');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;font:16px system-ui;background:#fff;color:#171717;display:grid;place-items:center;min-height:100svh}main{padding:32px}h1{font-size:22px}p{color:#737373;line-height:1.6}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}}</style><script>window.verified=async token=>{const res=await fetch('/api/monitor-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(res.ok)location.reload();else document.getElementById('error').textContent='验证失败，请刷新重试 / Verification failed. Reload to retry.'}</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head><body><main><h1>${title}</h1><p>通过验证后查看状态面板。<br>Complete verification to view the status panel.</p><div class="cf-turnstile" data-sitekey="${escape(row.site_key)}" data-callback="verified" data-theme="auto"></div><p id="error" role="alert"></p><a href="/admin/">后台 / Admin</a></main></body></html>`;
    return new Response(html, { headers: HEADERS });
  } catch { return Response.json({ error: 'Access verification unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}

export async function handleMonitorAccess(request, env, url) {
  if (url.pathname !== '/api/monitor-access') return null;
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
  if (request.headers.get('Origin') !== url.origin) return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  try {
    const data = await request.json();
    if (typeof data.token !== 'string' || !data.token || data.token.length > 2048) return Response.json({ error: 'Invalid verification' }, { status: 400, headers });
    const row = await verificationSettings(env);
    if (!row || !isValidJwtSecret(row.jwt_secret) || !['true', 1].includes(row.enabled) || !row.secret) throw new Error();
    if (!await verifyTurnstileToken(data.token, row.secret)) return Response.json({ error: 'Verification failed' }, { status: 403, headers });
    const receipt = await encryptTurnstileData({ verified: true, expires: Math.floor(Date.now() / 1000) + 3600 }, env, row);
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    headers['Set-Cookie'] = `${MONITOR_VERIFICATION_COOKIE}=${encodeURIComponent(receipt)}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax${secure}`;
    return Response.json({ verified: true }, { headers });
  } catch { return Response.json({ error: 'Verification unavailable' }, { status: 503, headers }); }
}

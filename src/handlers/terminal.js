import { getTerminalAdminPrincipal, validateCredentials } from '../middleware/auth.js';
import { issueTerminalNodeToken, verifyTerminalNodeToken, revokeTerminalNode } from '../database/terminal.js';
import { saveSiteOptions } from '../utils/settings.js';
import { validateTerminalSize, TERMINAL_LIMITS } from '../shared/terminalProtocol.js';

const ACTIONS = new Set(['terminal_enable_site', 'terminal_authorize_node', 'terminal_revoke_node', 'terminal_status', 'terminal_open', 'terminal_renew', 'terminal_close']);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const response = (code, status) => Response.json({error:code, code:status}, {status});
const sameOrigin = request => new URL(request.url).protocol === 'https:' && request.headers.get('Origin') === new URL(request.url).origin;

// Admission reads authority directly: cached dashboard settings cannot grant terminal access.
async function authority(env, sys) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_options'").first();
  if (!row) throw new Error('terminal_authority_unavailable');
  const settings = JSON.parse(row.value);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('terminal_authority_unavailable');
  return {...sys, ...settings, jwt_secret:settings.jwt_secret || '', terminal_enabled: settings.terminal_enabled === 'true' || settings.terminal_enabled === true, theme_url: settings.theme_url || ''};
}

async function nodeAuthority(env, serverId) {
  return env.DB.prepare(`SELECT n.enabled, n.credential_version FROM servers s
    LEFT JOIN terminal_nodes n ON n.server_id = s.id WHERE s.id = ?`).bind(serverId).first();
}

export async function notifyTerminalNodeRevoked(env, serverId) {
  if (!env.TERMINAL_BROKER) throw new Error('terminal_broker_unavailable');
  const node = await env.DB.prepare('SELECT credential_version FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
  const result = await brokerRequest(env, 'invalidate', {serverId, credentialVersion:node?.credential_version || 0});
  if (!result.ok) throw new Error('terminal_broker_notification_failed');
}

export async function terminalPreviewGuard(env) {
  try {
    const settings = await authority(env, null);
    return settings.terminal_enabled ? response('terminal_custom_frontend', 409) : null;
  } catch (_) { return response('terminal_authority_unavailable', 503); }
}

export async function disableTerminalAccess(env, sys) {
  await saveSiteOptions(env.DB, {terminal_enabled:'false'});
  await env.DB.prepare('UPDATE terminal_auth_sessions SET revoked_at = COALESCE(revoked_at, ?)').bind(Date.now()).run();
  if (sys) sys.terminal_enabled = 'false';
}

function brokerRequest(env, operation, context, data = null) {
  const stub = env.TERMINAL_BROKER.get(env.TERMINAL_BROKER.idFromName(context.serverId));
  // New headers/body, not an external Request clone: no forged internal context survives.
  return stub.fetch(new Request(`https://terminal.internal/${operation}`, {
    method: data ? 'POST' : 'GET',
    headers: {'X-CFSM-Terminal-Context':JSON.stringify(context), ...(operation === 'attach' || operation === 'control' ? {Upgrade:'websocket'} : {})},
    ...(data ? {body:JSON.stringify(data)} : {})
  }));
}

export async function handleTerminalAdminAction({request, env, sys, data}) {
  if (!ACTIONS.has(data.action)) return null;
  if (!sameOrigin(request)) return response('terminal_origin_denied', 403);
  try {
    const settings = await authority(env, sys);
    const owner = await getTerminalAdminPrincipal(request, env, settings);
    if (!owner) return response('terminal_login_required', 401);
    if (data.action === 'terminal_enable_site' || data.action === 'terminal_authorize_node') {
      const credentials = await validateCredentials(data.username || settings.username || env.API_USER_NAME || 'admin', data.password, env, settings);
      if (!credentials.valid) return response('terminal_step_up_required', 401);
    }
    if (data.action === 'terminal_enable_site') {
      if (settings.theme_url) return response('terminal_custom_frontend', 409);
      await saveSiteOptions(env.DB, {terminal_enabled:'true'});
      if (sys) sys.terminal_enabled = 'true';
      return Response.json({enabled:true});
    }
    if (!isId(data.serverId)) return response('terminal_invalid_node', 400);
    const node = await nodeAuthority(env, data.serverId);
    if (!node) return response('terminal_node_missing', 404);
    if (data.action === 'terminal_status' && node.credential_version == null) {
      return Response.json({enabled:false,connected:false,supported:false,protocol:null,platform:null,activeCount:0});
    }
    if (data.action === 'terminal_revoke_node') {
      await revokeTerminalNode(env.DB, data.serverId);
      await notifyTerminalNodeRevoked(env, data.serverId);
      return Response.json({enabled:false, brokerClosed:true});
    }
    if (data.action === 'terminal_authorize_node') {
      if (!settings.terminal_enabled || settings.theme_url) return response('terminal_disabled', 403);
      const issued = await issueTerminalNodeToken(env.DB, data.serverId);
      await notifyTerminalNodeRevoked(env, data.serverId);
      return Response.json(issued);
    }
    if (!env.TERMINAL_BROKER) return response('terminal_broker_unavailable', 503);
    const enabled = settings.terminal_enabled && !settings.theme_url && node.enabled === 1;
    if (data.action === 'terminal_status') {
      const result = await brokerRequest(env, 'status', {serverId:data.serverId});
      if (!result.ok) return result;
      return Response.json({...(await result.json()), enabled});
    }
    if (!enabled) return response('terminal_disabled', 403);
    const context = {serverId:data.serverId, owner:owner.jti, credentialVersion:node.credential_version,
      leaseUntil:Math.min(Date.now() + TERMINAL_LIMITS.authLeaseMs, owner.exp * 1000)};
    if (data.action === 'terminal_open') {
      if (!isId(data.clientRequestId) || !validateTerminalSize(data.cols, data.rows)) return response('terminal_invalid_open', 400);
      const result = await brokerRequest(env, 'open', context, {clientRequestId:data.clientRequestId, cols:data.cols, rows:data.rows});
      if (!result.ok) return result;
      const session = await result.json();
      return Response.json({...session, browserPath:`/admin/api/terminal/${data.serverId}/${session.sessionId}/ws`});
    }
    if (!isId(data.sessionId)) return response('terminal_invalid_session', 400);
    return await brokerRequest(env, data.action === 'terminal_renew' ? 'renew' : 'close', {...context, sessionId:data.sessionId});
  } catch (_) {
    return response('terminal_authority_or_broker_unavailable', 503);
  }
}

export async function handleTerminalUpgrade(request, env, sys) {
  const url = new URL(request.url);
  const browser = url.pathname.match(/^\/admin\/api\/terminal\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/ws$/);
  const session = url.pathname.match(/^\/api\/agent\/terminal\/session\/([A-Za-z0-9_-]{1,128})$/);
  const control = url.pathname === '/api/agent/terminal/control';
  if (!browser && !session && !control) return null;
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return response('terminal_upgrade_required', 426);
  if (url.search) return response('terminal_query_credentials_denied', 400);
  if (!env.TERMINAL_BROKER) return response('terminal_broker_unavailable', 503);
  try {
    const settings = await authority(env, sys);
    if (!settings.terminal_enabled || settings.theme_url) return response('terminal_disabled', 403);
    if (browser) {
      if (!sameOrigin(request) || !request.headers.get('Cookie') || request.headers.has('Authorization')) return response('terminal_browser_cookie_required', 403);
      const owner = await getTerminalAdminPrincipal(request, env, settings);
      if (!owner) return response('terminal_login_required', 401);
      const node = await nodeAuthority(env, browser[1]);
      if (!node || node.enabled !== 1) return response('terminal_node_disabled', 403);
      return await brokerRequest(env, 'attach', {serverId:browser[1], sessionId:browser[2], role:'browser', owner:owner.jti, credentialVersion:node.credential_version});
    }
    const serverId = request.headers.get('X-CFSM-Server-Id');
    const bearer = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const node = await verifyTerminalNodeToken(env.DB, serverId, bearer);
    if (!node) return response('terminal_agent_denied', 401);
    const currentNode = await nodeAuthority(env, serverId);
    if (!currentNode || currentNode.enabled !== 1 || currentNode.credential_version !== node.version) return response('terminal_agent_denied', 401);
    const context = {serverId, credentialVersion:node.version, role:'agent'};
    if (session) {
      context.sessionId = session[1];
      context.ticket = request.headers.get('X-CFSM-Terminal-Ticket');
      if (!/^[a-f0-9]{64}$/.test(context.ticket || '')) return response('terminal_ticket_denied', 403);
    }
    return await brokerRequest(env, control ? 'control' : 'attach', context);
  } catch (_) {
    return response('terminal_authority_or_broker_unavailable', 503);
  }
}

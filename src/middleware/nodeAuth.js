import { verifyNodeToken } from '../database/nodeCredentials.js';

const credentialFields = new Set(['secret', 'token', 'node_token', 'nodetoken', 'terminal_token', 'terminaltoken', 'api_secret', 'apisecret', 'authorization', 'auth_token', 'ws_token']);

export function hasReportCredentials(data) {
  if (!data || typeof data !== 'object') return false;
  const pending = [data];
  while (pending.length) {
    for (const [key, value] of Object.entries(pending.pop())) {
      if (credentialFields.has(key.toLowerCase())) return true;
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  return false;
}

export async function authenticateNodeRequest(request, db, requestedId) {
  const url = new URL(request.url);
  if (url.username || url.password || [...url.searchParams.keys()].some(key => credentialFields.has(key.toLowerCase()))) return null;
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const headerId = request.headers.get('X-CFSM-Server-Id') ?? undefined;
  const queryId = url.searchParams.get('id') ?? undefined;
  if ((requestedId !== undefined && headerId !== undefined && requestedId !== headerId) ||
      (queryId !== undefined && (requestedId ?? headerId) !== undefined && queryId !== (requestedId ?? headerId))) return null;
  return verifyNodeToken(db, token, requestedId ?? headerId ?? queryId);
}

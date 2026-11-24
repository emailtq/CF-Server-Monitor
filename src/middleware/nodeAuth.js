import { verifyNodeToken } from '../database/nodeCredentials.js';
import { isReportCredentialKey } from '../shared/reportCredentials.js';
export { hasReportCredentials } from '../shared/reportCredentials.js';

export async function authenticateNodeRequest(request, db, requestedId) {
  const url = new URL(request.url);
  if (url.username || url.password || [...url.searchParams.keys()].some(isReportCredentialKey)) return null;
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const headerId = request.headers.get('X-CFSM-Server-Id') ?? undefined;
  const queryId = url.searchParams.get('id') ?? undefined;
  if ((requestedId !== undefined && headerId !== undefined && requestedId !== headerId) ||
      (queryId !== undefined && (requestedId ?? headerId) !== undefined && queryId !== (requestedId ?? headerId))) return null;
  return verifyNodeToken(db, token, requestedId ?? headerId ?? queryId);
}

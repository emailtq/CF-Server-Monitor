const credentialFields = new Set(['secret', 'token', 'node_token', 'nodetoken',
  'terminal_token', 'terminaltoken', 'api_secret', 'apisecret', 'authorization',
  'auth_token', 'authtoken', 'ws_token', 'wstoken']);

export const isReportCredentialKey = key => credentialFields.has(key.toLowerCase());

export function hasReportCredentials(data) {
  if (!data || typeof data !== 'object') return false;
  const pending = [data];
  while (pending.length) {
    for (const [key, value] of Object.entries(pending.pop())) {
      if (isReportCredentialKey(key)) return true;
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  return false;
}

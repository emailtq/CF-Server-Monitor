export async function notifyNodeCredentialsInvalidated(env, serverId) {
  const node = await env.DB.prepare('SELECT token_version, credential_version FROM terminal_nodes WHERE server_id = ?').bind(serverId).first();
  if (!node) return;
  const notifications = [
    async () => {
      if (!env.METRICS_BROADCASTER) throw new Error('metrics_broadcaster_unavailable');
      return env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global')).fetch(new Request('https://metrics.internal/node-invalidated', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({serverId, tokenVersion:node.token_version})
      }));
    },
    async () => {
      if (!env.TERMINAL_BROKER) throw new Error('terminal_broker_unavailable');
      return env.TERMINAL_BROKER.get(env.TERMINAL_BROKER.idFromName(serverId)).fetch(new Request('https://terminal.internal/invalidate', {
        headers:{'X-CFSM-Terminal-Context':JSON.stringify({serverId, credentialVersion:node.credential_version})}
      }));
    }
  ];
  const results = await Promise.allSettled(notifications.map(notify => notify()));
  if (results.some(result => result.status === 'rejected' || !result.value.ok)) throw new Error('node_revocation_notification_failed');
}

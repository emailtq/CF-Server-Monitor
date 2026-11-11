export function notificationRuleSignature(rule) {
  return JSON.stringify([rule.type, rule.options, rule.scope.mode, [...rule.scope.serverIds].sort()]);
}

export async function createNotificationRuleIdentity(rule) {
  const legacySignature = notificationRuleSignature(rule);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacySignature));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { signature: `sha256:${hex}`, legacySignature };
}

export function matchesNotificationRuleIdentity(signature, identity) {
  return signature === identity.signature || signature === identity.legacySignature;
}

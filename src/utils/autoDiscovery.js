import { normalizeBooleanSetting } from './settings.js';

const MAX_NAME_LENGTH = 100;
const MAX_IP_LENGTH = 64;

export function isAutoDiscoveryEnabled(settings = {}) {
  return normalizeBooleanSetting(settings?.auto_discovery) === 'true';
}

function sanitizeServerName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function sanitizeIpValue(value) {
  const ip = String(value ?? '').trim();
  if (!ip || ip.length > MAX_IP_LENGTH) return '';
  if (!/^[0-9A-Fa-f:.]+$/.test(ip)) return '';
  // Agent 在公网 IP 查询失败时会回填 "0"（见 buildMetrics 的 firstNonEmpty(probes.IPv4, "0")），
  // 必须排除这类占位值，否则会建出名为 "0" 的服务器。
  if (/^0+(\.0+)*$/.test(ip)) return '';
  if (!ip.includes('.') && !ip.includes(':')) return '';
  return ip;
}

// 名称优先级：显式 name（≤100 字符）→ 连接来源 IP（CF-Connecting-IP）。
export function resolveDiscoveredServerName({ name, request } = {}) {
  const explicit = sanitizeServerName(name);
  if (explicit) return explicit;

  return sanitizeIpValue(request?.headers?.get('CF-Connecting-IP'));
}

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const THEMES = new Set(['default', 'serverstatus']);

export function renderMonitorVars({ host = '', theme = '', mode = '' } = {}) {
  if (host && (host.length > 253 || !HOSTNAME.test(host) || host.toLowerCase() === 'localhost' ||
      host.toLowerCase().endsWith('.localhost') || host.split('.').every(label => /^\d+$/.test(label)))) {
    throw new Error('MONITOR_COMPAT_HOST must be an exact ASCII DNS hostname');
  }
  if (theme && !THEMES.has(theme)) {
    throw new Error('MONITOR_COMPAT_THEME must be default or serverstatus');
  }

  if (mode && !['monitor', 'legacy'].includes(mode)) throw new Error('MONITOR_FRONTEND_MODE must be monitor or legacy');
  return (host ? `MONITOR_COMPAT_HOST = ${JSON.stringify(host.toLowerCase())}\n` : '') +
    (theme || host ? `MONITOR_COMPAT_THEME = ${JSON.stringify(theme || 'default')}\n` : '') +
    (mode ? `MONITOR_FRONTEND_MODE = ${JSON.stringify(mode)}\n` : '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(renderMonitorVars({ host: process.env.MONITOR_COMPAT_HOST || '', theme: process.env.MONITOR_COMPAT_THEME || '', mode: process.env.MONITOR_FRONTEND_MODE || '' }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

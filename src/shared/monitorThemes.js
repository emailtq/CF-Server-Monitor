import defaultTheme from '../../monitor-themes/default/theme.json' with { type: 'json' };
import serverstatusTheme from '../../monitor-themes/serverstatus/theme.json' with { type: 'json' };

export const MONITOR_THEMES = [defaultTheme, serverstatusTheme];
export const MONITOR_PREVIEW_PARAM = 'monitor_preview';
export const MONITOR_DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function findMonitorTheme(short) {
  return MONITOR_THEMES.find(theme => theme.short === short);
}

export function validMonitorConfig(short, config) {
  const theme = findMonitorTheme(short);
  if (!theme || !config || typeof config !== 'object' || Array.isArray(config)) return false;
  return Object.entries(config).every(([key, value]) =>
    (theme.config || []).some(field => field.key === key && field.type === 'boolean' && typeof value === 'boolean'));
}

export function validMonitorThemeBackup(state) {
  return state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).every(key => ['selected', 'configs'].includes(key)) &&
    (state.selected === null || !!findMonitorTheme(state.selected)) &&
    state.configs && typeof state.configs === 'object' && !Array.isArray(state.configs) &&
    Object.keys(state.configs).every(short => !!findMonitorTheme(short)) &&
    MONITOR_THEMES.every(theme => validMonitorConfig(theme.short, state.configs[theme.short]));
}

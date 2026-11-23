import defaultTheme from '../../monitor-themes/default/theme.json' with { type: 'json' };
import serverstatusTheme from '../../monitor-themes/serverstatus/theme.json' with { type: 'json' };

export const MONITOR_THEMES = [defaultTheme, serverstatusTheme];
export const MONITOR_PREVIEW_PARAM = 'monitor_preview';
export const MONITOR_REVISION_PARAM = 'monitor_revision';
export const MONITOR_DNS_HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function findMonitorTheme(short) {
  return MONITOR_THEMES.find(theme => theme.short === short);
}

export function validMonitorShort(short) {
  return typeof short === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(short);
}

export function monitorFieldFits(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
  if (field.type === 'select') return field.options?.some(option => option.value === value) === true;
  return typeof value === 'string';
}

export function monitorConfigForm(config) {
  if (!Array.isArray(config)) return [];
  const seen = new Set();
  const text = value => value === undefined || typeof value === 'string';
  const form = config.filter(field => {
    if (!field || typeof field !== 'object') return false;
    if (field.type === 'title') return typeof field.label === 'string' && !!field.label;
    const ok = typeof field.key === 'string' && !!field.key && !seen.has(field.key) &&
      ['string', 'text', 'number', 'boolean', 'select'].includes(field.type) && text(field.label) && text(field.help) &&
      [field.min, field.max].every(value => value === undefined || (typeof value === 'number' && Number.isFinite(value))) &&
      (field.type !== 'select' || (Array.isArray(field.options) && field.options.every(option =>
        typeof option?.value === 'string' && !!option.value && text(option.label)))) && monitorFieldFits(field, field.default);
    if (ok) seen.add(field.key);
    return ok;
  });
  return form.filter((field, i) => field.type !== 'title' || (form[i + 1] && form[i + 1].type !== 'title'));
}

export function monitorConfigValues(form, saved) {
  return Object.fromEntries(form.filter(field => field.type !== 'title').map(field =>
    [field.key, monitorFieldFits(field, saved[field.key]) ? saved[field.key] : field.default]));
}

export function monitorConfigOverrides(form, saved, values) {
  const result = { ...saved };
  for (const field of form.filter(field => field.type !== 'title')) {
    if (values[field.key] === field.default) delete result[field.key];
    else Object.defineProperty(result, field.key, { value: values[field.key], enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function validMonitorConfigObject(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  try { return new TextEncoder().encode(JSON.stringify(config)).length <= 64 * 1024; } catch { return false; }
}

export function validMonitorConfig(short, config) {
  const theme = findMonitorTheme(short);
  if (!theme || !config || typeof config !== 'object' || Array.isArray(config)) return false;
  return Object.entries(config).every(([key, value]) =>
    (theme.config || []).some(field => field.key === key && field.type === 'boolean' && typeof value === 'boolean'));
}

export function validMonitorThemeBackup(state) {
  if (state?.version === 2) return Object.keys(state).every(key => ['version', 'selected', 'configs', 'packages'].includes(key)) &&
    (state.selected === null || validMonitorShort(state.selected)) && state.configs && typeof state.configs === 'object' && !Array.isArray(state.configs) &&
    Object.entries(state.configs).every(([short, config]) => validMonitorShort(short) && validMonitorConfigObject(config)) &&
    MONITOR_THEMES.every(theme => Object.hasOwn(state.configs, theme.short)) &&
    (state.selected === null || Object.hasOwn(state.configs, state.selected)) &&
    Array.isArray(state.packages) && state.packages.length <= 128 &&
    state.packages.every(theme => theme && validMonitorShort(theme.short) &&
      ['version', 'url'].every(key => typeof theme[key] === 'string') &&
      (theme.repository === undefined || typeof theme.repository === 'string') &&
      Object.keys(theme).every(key => ['short', 'version', 'url', 'repository'].includes(key))) &&
    new Set(state.packages.map(theme => theme.short)).size === state.packages.length &&
    MONITOR_THEMES.every(theme => state.packages.some(pkg => pkg.short === theme.short) ||
      (theme.config || []).every(field => !Object.hasOwn(state.configs[theme.short], field.key) || monitorFieldFits(field, state.configs[theme.short][field.key])));
  return state && typeof state === 'object' && !Array.isArray(state) &&
    Object.keys(state).every(key => ['selected', 'configs'].includes(key)) &&
    (state.selected === null || !!findMonitorTheme(state.selected)) &&
    state.configs && typeof state.configs === 'object' && !Array.isArray(state.configs) &&
    Object.keys(state.configs).every(short => !!findMonitorTheme(short)) &&
    MONITOR_THEMES.every(theme => validMonitorConfig(theme.short, state.configs[theme.short]));
}

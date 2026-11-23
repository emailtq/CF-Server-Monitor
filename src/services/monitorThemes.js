import { MONITOR_THEMES, findMonitorTheme, validMonitorConfig, validMonitorThemeBackup, validMonitorShort,
  validMonitorConfigObject, monitorConfigForm, monitorFieldFits } from '../shared/monitorThemes.js';
import { AppError } from '../utils/errors.js';
import { loadMonitorThemeCatalog, loadMonitorPackageRegistry, loadMonitorRelease } from './monitorThemePackages.js';

const SELECTION_KEY = 'monitor_theme_selection';
const configKey = short => `monitor_theme_config:${short}`;
const KEYS = [SELECTION_KEY, ...MONITOR_THEMES.map(theme => configKey(theme.short))];

function configOverrides(short, config) {
  const fields = findMonitorTheme(short).config || [];
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => fields.find(field => field.key === key).default !== value));
}

export async function loadMonitorThemes(db, deploymentTheme) {
  try {
    if (deploymentTheme !== undefined && !findMonitorTheme(deploymentTheme)) throw new Error();
    const { themes } = await loadMonitorThemeCatalog(db);
    const { success, results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => '?').join(',')}) OR key LIKE 'monitor_theme_config:%'`).bind(...KEYS).all();
    if (!success || !Array.isArray(results)) throw new Error();
    const rows = Object.fromEntries(results.map(row => {
      if (typeof row.value !== 'string') throw new Error();
      return [row.key, JSON.parse(row.value)];
    }));
    const selected = rows[SELECTION_KEY] ?? null;
    if (Object.hasOwn(rows, SELECTION_KEY) && rows[SELECTION_KEY] !== null && !validMonitorShort(selected)) throw new Error();
    const configs = Object.create(null);
    const shorts = new Set([...themes.map(theme => theme.short), ...(selected ? [selected] : []), ...Object.keys(rows).filter(key => key.startsWith('monitor_theme_config:')).map(key => key.slice(21))]);
    for (const short of shorts) {
      const key = configKey(short);
      const config = Object.hasOwn(rows, key) ? rows[key] : {};
      const theme = themes.find(item => item.short === short);
      if (!validMonitorShort(short) || !validMonitorConfigObject(config) || (theme?.builtin &&
          (theme.config || []).some(field => Object.hasOwn(config, field.key) && !monitorFieldFits(field, config[field.key])))) throw new Error();
      configs[short] = config;
    }
    const requested = selected || deploymentTheme || 'default';
    return { selected, effective: themes.some(theme => theme.short === requested) ? requested : 'default', configs, themes };
  } catch {
    throw new AppError('monitorThemeUnavailable', 503);
  }
}

async function write(db, key, value) {
  try {
    const result = await db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value)).run();
    if (!result.success) throw new Error();
  } catch {
    throw new AppError('monitorThemeUnavailable', 503);
  }
}

export async function selectMonitorTheme(db, short) {
  const { themes } = await loadMonitorThemes(db);
  if (short !== null && !themes.some(theme => theme.short === short)) throw new AppError('monitorThemeInvalid', 400);
  await write(db, SELECTION_KEY, short);
}

export async function saveMonitorThemeConfig(db, short, config) {
  const { themes, configs } = await loadMonitorThemes(db);
  const theme = themes.find(item => item.short === short);
  if (!theme || !validMonitorConfigObject(config) || (theme.builtin && Object.entries(config).some(([key, value]) =>
      !(theme.config || []).some(field => field.key === key && monitorFieldFits(field, value)) &&
      !Object.hasOwn(configs[short], key)))) throw new AppError('monitorThemeInvalid', 400);
  const form = monitorConfigForm(theme.config).filter(field => field.type !== 'title');
  if (Object.entries(config).some(([key, value]) => form.some(field => field.key === key && !monitorFieldFits(field, value)))) throw new AppError('monitorThemeInvalid', 400);
  const values = Object.fromEntries(Object.entries(config).filter(([key, value]) => !form.some(field => field.key === key && field.default === value)));
  await write(db, configKey(short), values);
}

export async function getMonitorThemeConfig(db, short) {
  if (!validMonitorShort(short)) throw new AppError('monitorThemeInvalid', 400);
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(configKey(short)).first();
    const config = row ? JSON.parse(row.value) : {};
    if (!validMonitorConfigObject(config)) throw new Error();
    return config;
  } catch { throw new AppError('monitorThemeUnavailable', 503); }
}

export async function importMonitorThemes(db, state) {
  if (!validMonitorThemeBackup(state)) throw new AppError('monitorThemeInvalid', 400);
  const entries = [[SELECTION_KEY, state.selected], ...Object.entries(state.configs).map(([short, config]) =>
    [configKey(short), state.version === 2 ? config : configOverrides(short, config)])];
  try {
    const results = await db.batch(entries.map(([key, value]) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value))));
    if (results.some(result => !result.success)) throw new Error();
  } catch {
    throw new AppError('monitorThemeUnavailable', 503);
  }
}

export async function exportMonitorThemes(db) {
  const { selected, configs } = await loadMonitorThemes(db);
  const { registry } = await loadMonitorPackageRegistry(db);
  if ((selected === null || findMonitorTheme(selected)) && !Object.keys(registry).length && Object.keys(configs).every(short => !!findMonitorTheme(short)) &&
      MONITOR_THEMES.every(theme => validMonitorConfig(theme.short, configs[theme.short]))) return { selected, configs };
  const packages = [];
  for (const revision of Object.values(registry)) {
    const release = await loadMonitorRelease(db, revision);
    if (!release) throw new AppError('monitorThemeUnavailable', 503);
    packages.push({ short: release.manifest.short, version: release.manifest.version, url: release.manifest.url,
      ...(release.repository ? { repository: release.repository } : {}) });
  }
  return { version: 2, selected, configs, packages };
}

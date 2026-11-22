import { MONITOR_THEMES, findMonitorTheme, validMonitorConfig, validMonitorThemeBackup } from '../shared/monitorThemes.js';
import { AppError } from '../utils/errors.js';

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
    const { success, results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${KEYS.map(() => '?').join(',')})`).bind(...KEYS).all();
    if (!success || !Array.isArray(results)) throw new Error();
    const rows = Object.fromEntries(results.map(row => {
      if (typeof row.value !== 'string') throw new Error();
      return [row.key, JSON.parse(row.value)];
    }));
    const selected = rows[SELECTION_KEY] ?? null;
    if (Object.hasOwn(rows, SELECTION_KEY) && rows[SELECTION_KEY] !== null && !findMonitorTheme(selected)) throw new Error();
    const configs = {};
    for (const theme of MONITOR_THEMES) {
      const key = configKey(theme.short);
      const config = Object.hasOwn(rows, key) ? rows[key] : {};
      if (!validMonitorConfig(theme.short, config)) throw new Error();
      configs[theme.short] = config;
    }
    return { selected, effective: selected || deploymentTheme || 'default', configs };
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
  if (short !== null && !findMonitorTheme(short)) throw new AppError('monitorThemeInvalid', 400);
  await loadMonitorThemes(db);
  await write(db, SELECTION_KEY, short);
}

export async function saveMonitorThemeConfig(db, short, config) {
  if (!validMonitorConfig(short, config)) throw new AppError('monitorThemeInvalid', 400);
  await loadMonitorThemes(db);
  await write(db, configKey(short), configOverrides(short, config));
}

export async function importMonitorThemes(db, state) {
  if (!validMonitorThemeBackup(state)) throw new AppError('monitorThemeInvalid', 400);
  const entries = [[SELECTION_KEY, state.selected], ...MONITOR_THEMES.map(theme => [configKey(theme.short), configOverrides(theme.short, state.configs[theme.short])])];
  try {
    const results = await db.batch(entries.map(([key, value]) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value))));
    if (results.some(result => !result.success)) throw new Error();
  } catch {
    throw new AppError('monitorThemeUnavailable', 503);
  }
}

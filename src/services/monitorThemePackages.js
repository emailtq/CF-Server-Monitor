import { AppError } from '../utils/errors.js';
import { MONITOR_THEMES, findMonitorTheme, validMonitorShort } from '../shared/monitorThemes.js';
import { monitorArchivePath, parseMonitorThemeArchive } from '../shared/monitorThemeArchive.js';

const REGISTRY = 'monitor_theme_packages';
const releaseKey = revision => `monitor_theme_release:${revision}`;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = () => new AppError('monitorThemeUnavailable', 503);
const invalid = () => new AppError('monitorThemeInvalid', 400);
const mimes = { html: 'text/html;charset=UTF-8', js: 'application/javascript', css: 'text/css', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', mp4: 'video/mp4', txt: 'text/plain' };

export function validMonitorRevision(revision) {
  return typeof revision === 'string' && (REVISION.test(revision) || MONITOR_THEMES.some(theme => revision === `builtin-${theme.short}`));
}

export async function loadMonitorPackageRegistry(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(REGISTRY).first();
    const registry = row ? JSON.parse(row.value) : {};
    if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).length > 128 ||
        !Object.entries(registry).every(([short, revision]) => validMonitorShort(short) && REVISION.test(revision))) throw unavailable();
    return { registry, raw: row?.value ?? null };
  } catch { throw unavailable(); }
}

export async function loadMonitorRelease(db, revision) {
  if (!validMonitorRevision(revision)) throw invalid();
  const builtin = MONITOR_THEMES.find(theme => revision === `builtin-${theme.short}`);
  if (builtin) return { manifest: builtin, revision, builtin: true };
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(releaseKey(revision)).first();
    if (!row) return null;
    const release = JSON.parse(row.value);
    if (release.revision !== revision || release.key !== `monitor-theme/releases/${revision}.tar` || !validMonitorShort(release.manifest?.short) || !release.files ||
        typeof release.files !== 'object' || !Number.isSafeInteger(release.size) || release.size < 0 || release.size > 73 * 1024 * 1024 ||
        Object.keys(release.files).length > 2000 || !Object.entries(release.files).every(([name, file]) =>
          monitorArchivePath(name) === name && Number.isSafeInteger(file.offset) && file.offset >= 0 &&
          Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 8 * 1024 * 1024 && file.offset + file.size <= release.size)) throw unavailable();
    return release;
  } catch { throw unavailable(); }
}

export async function loadMonitorThemeCatalog(db) {
  const { registry } = await loadMonitorPackageRegistry(db);
  const themes = MONITOR_THEMES.map(theme => ({ ...theme, builtin: true, revision: `builtin-${theme.short}` }));
  // Registry size is bounded; read manifest rows in one D1 query, never read credentials.
  if (Object.keys(registry).length) {
    const keys = Object.values(registry).map(releaseKey);
    try {
      const { success, results } = await db.prepare(`SELECT key, json_object('manifest',json_extract(value,'$.manifest'),
        'revision',json_extract(value,'$.revision'),'repository',json_extract(value,'$.repository')) AS value
        FROM settings WHERE key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
      if (!success || results.length !== keys.length) throw unavailable();
      for (const row of results) {
        const release = JSON.parse(row.value), manifest = release.manifest;
        if (!manifest || !validMonitorShort(manifest.short) || registry[manifest.short] !== release.revision || row.key !== releaseKey(release.revision)) throw unavailable();
        const theme = { ...manifest, builtin: false, revision: release.revision,
          canUpdate: !!release.repository || /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(manifest.url) };
        const i = themes.findIndex(item => item.short === theme.short);
        if (i < 0) themes.push(theme); else themes[i] = theme;
      }
    } catch { throw unavailable(); }
  }
  return { themes, registry };
}

async function publishPointer(db, short, revision, expectedRevision) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { registry, raw } = await loadMonitorPackageRegistry(db);
    if ((Object.hasOwn(registry, short) ? registry[short] : null) !== expectedRevision) throw new AppError('monitorThemeConflict', 409);
    const next = Object.assign(Object.create(null), registry);
    if (revision === null) delete next[short]; else next[short] = revision;
    if (Object.keys(next).length > 128) throw new AppError('monitorThemeLimit', 409);
    const value = JSON.stringify(next);
    const result = raw === null
      ? await db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').bind(REGISTRY, value).run()
      : await db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(value, REGISTRY, raw).run();
    if (!result.success) throw unavailable();
    if (result.meta?.changes === 1) return;
  }
  throw new AppError('monitorThemeConflict', 409);
}

export async function installMonitorTheme(env, archive, { expectedShort, repository, expectedRevision } = {}) {
  if (!env.MONITOR_THEME_BUCKET) throw new AppError('monitorThemeStorageUnavailable', 503);
  if (expectedShort !== undefined && !validMonitorShort(expectedShort)) throw invalid();
  const initial = await loadMonitorPackageRegistry(env.DB);
  if (expectedRevision !== undefined && (!expectedShort || initial.registry[expectedShort] !== expectedRevision)) throw new AppError('monitorThemeConflict', 409);
  const revision = crypto.randomUUID(), key = `monitor-theme/releases/${revision}.tar`;
  const bucket = env.MONITOR_THEME_BUCKET;
  let upload, complete = false;
  try {
    upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: 'application/x-tar' } });
    const partSize = 5 * 1024 * 1024;
    let buffer = new Uint8Array(partSize), at = 0;
    const parts = [];
    const flush = async last => {
      if (!at) return;
      try { parts.push(await upload.uploadPart(parts.length + 1, last ? buffer.subarray(0, at) : buffer)); }
      catch { throw unavailable(); }
      buffer = new Uint8Array(partSize); at = 0;
    };
    const parsed = await parseMonitorThemeArchive(archive, async chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        const size = Math.min(partSize - at, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + size), at); at += size; offset += size;
        if (at === partSize) await flush(false);
      }
    });
    const short = parsed.manifest.short;
    if (expectedShort !== undefined && short !== expectedShort) throw invalid();
    await flush(true);
    await upload.complete(parts); complete = true;
    const release = { ...parsed, revision, key, createdAt: Date.now(), ...(repository ? { repository } : {}) };
    const write = await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(releaseKey(revision), JSON.stringify(release)).run();
    if (!write.success) throw unavailable();
    await publishPointer(env.DB, short, revision, Object.hasOwn(initial.registry, short) ? initial.registry[short] : null);
    return { ...parsed.manifest, short, revision };
  } catch (error) {
    // Only this unpublished revision is removed; the previous active version remains intact.
    try { if (complete) await bucket.delete(key); else if (upload) await upload.abort(); } catch {}
    try { await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(releaseKey(revision)).run(); } catch {}
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}

export async function removeMonitorTheme(env, short) {
  if (!validMonitorShort(short)) throw invalid();
  const { registry } = await loadMonitorPackageRegistry(env.DB);
  if (!Object.hasOwn(registry, short)) throw invalid();
  await publishPointer(env.DB, short, null, registry[short]);
  // Published immutable revisions stay available to existing tabs; config rows are independent.
}

export async function readMonitorThemeFile(env, short, relativePath, revision = null, method = 'GET', search = '') {
  if (!validMonitorShort(short)) throw invalid();
  const path = monitorArchivePath(relativePath);
  if (!revision) {
    const { registry } = await loadMonitorPackageRegistry(env.DB);
    revision = Object.hasOwn(registry, short) ? registry[short] : `builtin-${short}`;
  }
  const release = await loadMonitorRelease(env.DB, revision);
  if (!release || release.manifest.short !== short) return null;
  if (release.builtin) {
    if (!env.ASSETS) return null;
    const response = await env.ASSETS.fetch(new Request(`http://monitor-theme/_monitor_theme/${short}/${path.split('/').map(encodeURIComponent).join('/')}${search}`, { method }));
    return response.ok ? response : null;
  }
  if (!env.MONITOR_THEME_BUCKET) throw new AppError('monitorThemeStorageUnavailable', 503);
  const entry = Object.hasOwn(release.files, path) ? release.files[path] : null;
  if (!entry) return null;
  const headers = new Headers({ 'Content-Type': mimes[path.split('.').pop().toLowerCase()] || 'application/octet-stream', 'Content-Length': String(entry.size) });
  if (method === 'HEAD' || entry.size === 0) return await env.MONITOR_THEME_BUCKET.head(release.key)
    ? new Response(method === 'HEAD' ? null : '', { headers }) : null;
  const object = await env.MONITOR_THEME_BUCKET.get(release.key, { range: { offset: entry.offset, length: entry.size } });
  return object ? new Response(object.body, { headers }) : null;
}

export async function resolveMonitorThemeRelease(env, selected, revision = null) {
  if (revision) return loadMonitorRelease(env.DB, revision);
  const { registry } = await loadMonitorPackageRegistry(env.DB);
  return loadMonitorRelease(env.DB, Object.hasOwn(registry, selected) ? registry[selected] : `builtin-${findMonitorTheme(selected)?.short || 'default'}`);
}

import { AppError } from '../utils/errors.js';
import { MONITOR_THEMES, findMonitorTheme, validMonitorShort } from '../shared/monitorThemes.js';
import { monitorArchivePath, parseMonitorThemeArchive } from '../shared/monitorThemeArchive.js';

const REGISTRY = 'monitor_theme_packages';
const CHUNK_SIZE = 512 * 1024;
const WRITE_BATCH = 8;
const READ_BATCH = 4;
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
    if (release.revision !== revision || release.storage !== 'd1' || !validMonitorShort(release.manifest?.short) || !release.files ||
        typeof release.files !== 'object' || !Number.isSafeInteger(release.size) || release.size < 0 || release.size > 73 * 1024 * 1024 ||
        Object.keys(release.files).length > 2000 || !Object.entries(release.files).every(([name, file]) =>
          monitorArchivePath(name) === name && Number.isSafeInteger(file.offset) && file.offset >= 0 &&
          Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 8 * 1024 * 1024 && file.offset + file.size <= release.size)) throw unavailable();
    return release;
  } catch { throw unavailable(); }
}

export async function loadMonitorThemeCatalog(db) {
  const { registry } = await loadMonitorPackageRegistry(db);
  const themes = MONITOR_THEMES.map(theme => ({ ...theme, builtin: true, preview: theme.short === 'default', revision: `builtin-${theme.short}` }));
  // Registry size is bounded; read manifest rows in one D1 query, never read credentials.
  if (Object.keys(registry).length) {
    const keys = Object.values(registry).map(releaseKey);
    try {
      const { success, results } = await db.prepare(`SELECT key, json_object('manifest',json_extract(value,'$.manifest'),
        'revision',json_extract(value,'$.revision'),'repository',json_extract(value,'$.repository'),
        'preview',json_extract(value,'$.preview')) AS value
        FROM settings WHERE key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
      if (!success || results.length !== keys.length) throw unavailable();
      for (const row of results) {
        const release = JSON.parse(row.value), manifest = release.manifest;
        if (!manifest || !validMonitorShort(manifest.short) || registry[manifest.short] !== release.revision || row.key !== releaseKey(release.revision)) throw unavailable();
        const theme = { ...manifest, builtin: false, revision: release.revision,
          preview: !!release.preview || manifest.short === 'default',
          canUpdate: !!release.repository || /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[/?#]|$)/.test(manifest.url) };
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
  if (!env.DB) throw new AppError('monitorThemeStorageUnavailable', 503);
  if (expectedShort !== undefined && !validMonitorShort(expectedShort)) throw invalid();
  const initial = await loadMonitorPackageRegistry(env.DB);
  if (expectedRevision !== undefined && (!expectedShort || (Object.hasOwn(initial.registry, expectedShort) ? initial.registry[expectedShort] : null) !== expectedRevision)) throw new AppError('monitorThemeConflict', 409);
  const revision = crypto.randomUUID();
  try {
    // Create only for runtime installs; builtin readers keep their existing database contract.
    const schema = await env.DB.prepare(`CREATE TABLE IF NOT EXISTS monitor_theme_chunks (
      revision TEXT NOT NULL, part INTEGER NOT NULL CHECK(part >= 0),
      data BLOB NOT NULL CHECK(typeof(data) = 'blob' AND length(data) > 0 AND length(data) <= ${CHUNK_SIZE}),
      PRIMARY KEY(revision,part)
    ) WITHOUT ROWID`).run();
    if (!schema.success) throw unavailable();
    let buffer = new Uint8Array(CHUNK_SIZE), at = 0, part = 0, pending = [];
    const flush = async last => {
      if (at) {
        pending.push(env.DB.prepare('INSERT INTO monitor_theme_chunks(revision,part,data) VALUES (?,?,?)')
          .bind(revision, part++, at === CHUNK_SIZE ? buffer.buffer : buffer.slice(0, at).buffer));
        buffer = new Uint8Array(CHUNK_SIZE); at = 0;
      }
      if (pending.length === WRITE_BATCH || (last && pending.length)) {
        let results;
        try { results = await env.DB.batch(pending); } catch { throw unavailable(); }
        if (results.some(result => !result.success)) throw unavailable();
        pending = [];
      }
    };
    const parsed = await parseMonitorThemeArchive(archive, async chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        const size = Math.min(CHUNK_SIZE - at, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + size), at); at += size; offset += size;
        if (at === CHUNK_SIZE) await flush(false);
      }
    });
    const short = parsed.manifest.short;
    if (expectedShort !== undefined && short !== expectedShort) throw invalid();
    await flush(true);
    const release = { ...parsed, revision, storage: 'd1', createdAt: Date.now(), ...(repository ? { repository } : {}) };
    const write = await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?)').bind(releaseKey(revision), JSON.stringify(release)).run();
    if (!write.success) throw unavailable();
    await publishPointer(env.DB, short, revision, Object.hasOwn(initial.registry, short) ? initial.registry[short] : null);
    return { ...parsed.manifest, short, revision };
  } catch (error) {
    // Only this unpublished revision is removed; the previous active version remains intact.
    try { await env.DB.prepare('DELETE FROM monitor_theme_chunks WHERE revision=?').bind(revision).run(); } catch {}
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

export async function readMonitorThemeFile(env, short, relativePath, revision = null, method = 'GET', search = '', origin = null) {
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
  if (!env.DB) throw new AppError('monitorThemeStorageUnavailable', 503);
  const entry = Object.hasOwn(release.files, path) ? release.files[path] : null;
  if (!entry) return null;
  return readReleaseEntry(env, release, entry, path, method, origin);
}

export async function readMonitorThemeThumbnail(env, short) {
  if (!validMonitorShort(short)) throw invalid();
  const release = await resolveMonitorThemeRelease(env, short);
  if (!release || release.manifest.short !== short) return null;
  if (!release.preview) {
    if (short !== 'default' || !env.ASSETS) return null;
    const response = await env.ASSETS.fetch(new Request('http://monitor-theme/_monitor_theme_metadata/default/preview.png'));
    return response.ok ? response : null;
  }
  const entry = release.preview;
  if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 8 * 1024 * 1024 || entry.offset + entry.size > release.size) throw unavailable();
  return readReleaseEntry(env, release, entry, 'preview.png', 'GET', null);
}

async function readReleaseEntry(env, release, entry, path, method, origin) {
  const revision = release.revision;
  const headers = new Headers({ 'Content-Type': mimes[path.split('.').pop().toLowerCase()] || 'application/octet-stream', 'Content-Length': String(entry.size) });
  const cacheKey = origin ? new Request(`${origin}/_monitor_theme/cache/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`) : null;
  const cache = cacheKey && typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return new Response(method === 'HEAD' ? null : cached.body, { headers: cached.headers });
    } catch { /* Cache is an optimization; D1 retains the published bytes. */ }
  }
  const first = entry.size ? Math.floor(entry.offset / CHUNK_SIZE) : 0;
  const last = entry.size ? Math.floor((entry.offset + entry.size - 1) / CHUNK_SIZE) : Math.ceil(release.size / CHUNK_SIZE) - 1;
  try {
    const stats = await env.DB.prepare('SELECT COUNT(*) AS count,SUM(length(data)) AS size FROM monitor_theme_chunks WHERE revision=? AND part BETWEEN ? AND ?')
      .bind(revision, first, last).first();
    const expectedSize = Math.min(release.size, (last + 1) * CHUNK_SIZE) - first * CHUNK_SIZE;
    if (!stats || stats.count !== last - first + 1 || stats.size !== expectedSize) throw unavailable();
    if (method === 'HEAD' || entry.size === 0) return new Response(method === 'HEAD' ? null : '', { headers });
    const read = async part => {
      // Hex avoids the much larger JSON number arrays returned for a D1 BLOB.
      const { success, results } = await env.DB.prepare(`SELECT part,hex(substr(data,
        MAX(1,?1 - part * ${CHUNK_SIZE} + 1),
        MIN(length(data),?2 - part * ${CHUNK_SIZE}) - MAX(0,?1 - part * ${CHUNK_SIZE}))) AS bytes
        FROM monitor_theme_chunks WHERE revision=?3 AND part BETWEEN ?4 AND ?5 ORDER BY part`)
        .bind(entry.offset, entry.offset + entry.size, revision, part, Math.min(last, part + READ_BATCH - 1)).all();
      if (!success || results.length !== Math.min(READ_BATCH, last - part + 1) || results.some((row, i) =>
        row.part !== part + i || row.bytes.length !== (Math.min((row.part + 1) * CHUNK_SIZE, entry.offset + entry.size) -
          Math.max(row.part * CHUNK_SIZE, entry.offset)) * 2)) throw unavailable();
      return results;
    };
    let next = first, ready = await read(first), streamError;
    const body = new ReadableStream({ async pull(controller) {
      try {
        const rows = ready || await read(next); ready = null;
        for (const row of rows) {
          const bytes = new Uint8Array(row.bytes.length / 2);
          for (let i = 0; i < bytes.length; i++) {
            const a = row.bytes.charCodeAt(i * 2), b = row.bytes.charCodeAt(i * 2 + 1);
            bytes[i] = ((a > 57 ? a - 55 : a - 48) << 4) | (b > 57 ? b - 55 : b - 48);
          }
          controller.enqueue(bytes); next++;
        }
        if (next > last) controller.close();
      } catch { streamError = unavailable(); controller.error(streamError); }
    } });
    const response = new Response(body, { headers });
    if (cache) {
      const cached = response.clone(); cached.headers.set('Cache-Control', 'public, max-age=86400');
      await cache.put(cacheKey, cached).catch(() => {});
      if (streamError) throw streamError;
    }
    return response;
  } catch { throw unavailable(); }
}

export async function resolveMonitorThemeRelease(env, selected, revision = null) {
  if (revision) return loadMonitorRelease(env.DB, revision);
  const { registry } = await loadMonitorPackageRegistry(env.DB);
  return loadMonitorRelease(env.DB, Object.hasOwn(registry, selected) ? registry[selected] : `builtin-${findMonitorTheme(selected)?.short || 'default'}`);
}

import { AppError } from '../utils/errors.js';
import { installMonitorTheme } from './monitorThemePackages.js';
import { MONITOR_ARCHIVE_LIMIT } from '../shared/monitorThemeArchive.js';

export function parseMonitorRepository(address) {
  try {
    const url = new URL(address);
    const match = /^\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9_-][A-Za-z0-9_.-]{0,99})\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match) throw new Error();
    return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  } catch { throw new AppError('monitorThemeRepositoryInvalid', 400); }
}

export async function installMonitorRepository(env, address, expectedShort, expectedRevision) {
  if (!env.MONITOR_THEME_BUCKET) throw new AppError('monitorThemeStorageUnavailable', 503);
  const repository = parseMonitorRepository(address);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let stage = 'metadata', status = 0;
  try {
    const metadata = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { 'User-Agent': 'CF-Server-Monitor', Accept: 'application/vnd.github+json' }, redirect: 'manual', signal: controller.signal
    });
    status = metadata.status;
    if (!metadata.ok) { await metadata.body?.cancel(); throw new AppError('monitorThemeDownloadFailed', 502); }
    const reader = metadata.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 512 * 1024) { await reader.cancel(); throw new AppError('monitorThemeDownloadFailed', 502); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { buffer.set(chunk, at); at += chunk.length; }
    const release = JSON.parse(new TextDecoder().decode(buffer));
    if (typeof release.tag_name !== 'string' || !release.tag_name || release.tag_name.length > 200 ||
        !release.assets?.some(asset => asset.name === 'theme.tar.gz' && asset.size > 0 && asset.size <= MONITOR_ARCHIVE_LIMIT)) throw new AppError('monitorThemePackageMissing', 400);
    let url = new URL(`https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/theme.tar.gz`);
    stage = 'download';
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new AppError('monitorThemeDownloadFailed', 502);
      const response = await fetch(url, { headers: { 'User-Agent': 'CF-Server-Monitor' }, redirect: 'manual', signal: controller.signal });
      status = response.status;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location'); await response.body?.cancel();
        if (!location) throw new AppError('monitorThemeDownloadFailed', 502);
        url = new URL(location, url); continue;
      }
      if (!response.ok) throw new AppError('monitorThemeDownloadFailed', 502);
      if (Number(response.headers.get('Content-Length')) > MONITOR_ARCHIVE_LIMIT) { await response.body?.cancel(); throw new AppError('monitorThemeArchiveTooLarge', 413); }
      stage = 'install';
      return await installMonitorTheme(env, response.body, { expectedShort, repository, expectedRevision });
    }
    throw new AppError('monitorThemeDownloadFailed', 502);
  } catch (error) {
    // Diagnose remote failures without recording signed asset URLs, headers or package contents.
    console.warn('[MonitorThemes] repository operation failed', { stage, status, reason: error instanceof AppError ? error.message : error?.name });
    if (error instanceof AppError) throw error;
    throw new AppError('monitorThemeDownloadFailed', 502);
  } finally { clearTimeout(timer); }
}

import { AppError } from '../utils/errors.js';
import { installMonitorTheme, loadMonitorPackageRegistry, loadMonitorRelease, assertMonitorThemePublisher } from './monitorThemePackages.js';
import { monitorBuiltinRevision } from '../shared/monitorThemes.js';
import { MONITOR_ARCHIVE_LIMIT } from '../shared/monitorThemeArchive.js';

export function parseMonitorRepository(address) {
  try {
    const input = address.trim();
    const url = input.startsWith('github.com/') ? `https://${input}` : input;
    // Read the raw owner/repo before URL path normalisation; pasted suffixes are never fetched.
    const match = /^https:\/\/github\.com(?::443)?\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:[/?#]|$)/i.exec(url);
    if (!match || url.includes('\\')) throw new Error();
    const owner = match[1], repo = match[2].replace(/\.git$/, '');
    if (!repo || [owner, repo].some(segment => segment === '.' || segment === '..')) throw new Error();
    return `${owner}/${repo}`;
  } catch { throw new AppError('monitorThemeRepositoryInvalid', 400); }
}

export async function installMonitorRepository(env, address, expectedShort, expectedRevision, expectedVersion, publisher) {
  if (!env.DB) throw new AppError('monitorThemeStorageUnavailable', 503);
  const repository = parseMonitorRepository(address);
  const {registry:initialRegistry}=await loadMonitorPackageRegistry(env.DB);
  if (expectedShort) {
    const current = await loadMonitorRelease(env.DB, Object.hasOwn(initialRegistry, expectedShort) ? initialRegistry[expectedShort] : monitorBuiltinRevision(expectedShort));
    if (current?.manifest.cf_revision) throw new AppError('monitorThemeConsumerRevisionRequired', 409);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let stage = 'metadata', status = 0;
  try {
    // GitHub's official latest-release redirect avoids the shared Workers REST API quota.
    const metadataUrl = `https://github.com/${repository}/releases/latest`;
    const metadata = await fetch(metadataUrl, { headers: { 'User-Agent': 'CF-Server-Monitor' }, redirect: 'manual', signal: controller.signal });
    status = metadata.status;
    const location = metadata.headers.get('Location'); await metadata.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(status) || !location) throw new AppError('monitorThemeDownloadFailed', 502);
    const latest = new URL(location, metadataUrl), prefix = `/${repository}/releases/tag/`;
    if (latest.protocol !== 'https:' || latest.hostname !== 'github.com' || latest.port || latest.username || latest.password || latest.search || latest.hash ||
        !latest.pathname.toLowerCase().startsWith(prefix.toLowerCase())) throw new AppError('monitorThemeDownloadFailed', 502);
    const tag = decodeURIComponent(latest.pathname.slice(prefix.length));
    if (!tag || tag.length > 200 || tag === '.' || tag === '..' || /[\x00-\x1f\x7f]/.test(tag)) throw new AppError('monitorThemeDownloadFailed', 502);
    if (expectedVersion !== undefined && tag.replace(/^v/, '') === expectedVersion) {
      await assertMonitorThemePublisher(env.DB,publisher);
      const { registry } = await loadMonitorPackageRegistry(env.DB);
      if ((Object.hasOwn(registry, expectedShort) ? registry[expectedShort] : null) !== expectedRevision) throw new AppError('monitorThemeConflict', 409);
      return { updated: false, version: expectedVersion };
    }
    let url = new URL(`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/theme.tar.gz`);
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
      if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status === 404 ? 'monitorThemePackageMissing' : 'monitorThemeDownloadFailed', response.status === 404 ? 400 : 502); }
      if (Number(response.headers.get('Content-Length')) > MONITOR_ARCHIVE_LIMIT) { await response.body?.cancel(); throw new AppError('monitorThemeArchiveTooLarge', 413); }
      stage = 'install';
      const theme = await installMonitorTheme(env, response.body, { expectedShort, repository, expectedRevision, publisher, initialRegistry });
      return { ...theme, updated: true };
    }
    throw new AppError('monitorThemeDownloadFailed', 502);
  } catch (error) {
    // Diagnose remote failures without recording signed asset URLs, headers or package contents.
    console.warn('[MonitorThemes] repository operation failed', { stage, status, reason: error instanceof AppError ? error.message : error?.name });
    if (error instanceof AppError) throw error;
    throw new AppError('monitorThemeDownloadFailed', 502);
  } finally { clearTimeout(timer); }
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packageConsumer } from './package-monitor-consumer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'monitor-themes');
const lock = JSON.parse(fs.readFileSync(path.join(directory, 'consumer-revisions.json'), 'utf8'));
const install = process.argv.includes('--install');
const requested = process.argv.slice(2).filter(arg => arg !== '--install');
const names = requested.length ? requested : Object.keys(lock.themes);
for (const name of names) if (!Object.hasOwn(lock.themes, name)) throw new Error(`Unknown consumer: ${name}`);
for (const name of names) {
  const baseline = lock.themes[name], target = path.join(directory, name), source = path.join(target, 'source');
  const original = JSON.parse(fs.readFileSync(path.join(source, 'theme.json'), 'utf8'));
  if (original.version !== baseline.version) throw new Error(`Unreviewed upstream version: ${name}`);
  const manager = name === 'naive' ? 'pnpm' : 'npm';
  const run = args => {
    const result = spawnSync(manager, args, { cwd: source, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${name}: ${manager} ${args.join(' ')} exited ${result.status}`);
  };
  if (install) run(manager === 'pnpm' ? ['install', '--frozen-lockfile'] : ['ci', '--no-audit', '--no-fund']);
  run(['run', 'build']);
  const manifest = { ...original, version: `${baseline.version}-cf.1`, cf_revision: lock.revision,
    upstream: { version: baseline.version, commit: baseline.commit, url: `https://github.com/${baseline.repository}` } };
  fs.writeFileSync(path.join(target, 'theme.json'), JSON.stringify(manifest, null, 2) + '\n');
  const output = path.join(target, 'release');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'theme.tar.gz'), packageConsumer(source, manifest, ['LICENSE', 'preview.png']));
  console.log(`${name}: ${manifest.version}, CF ${lock.revision}; ${path.join(output, 'theme.tar.gz')}`);
}

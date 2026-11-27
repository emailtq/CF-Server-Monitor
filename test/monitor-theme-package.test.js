import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = [
  { short: 'default', version: '1.4.3' },
  { short: 'serverstatus', version: '1.5.1' }
];

test('bundled Monitor packages keep their audited metadata and isolated dist roots', () => {
  for (const { short, version } of packages) {
    const packageRoot = path.join(root, 'monitor-themes', short);
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'theme.json'), 'utf8'));
    assert.equal(metadata.short, short);
    assert.equal(metadata.version, `${version}-cf.1`);
    assert.equal(metadata.upstream.version, version);
    assert.equal(metadata.cf_revision, "nullable.1");
    assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, "source/theme.json"), "utf8")).version, version);

    const distRoot = path.join(packageRoot, 'dist');
    for (const file of ['index.html', 'favicon.svg', 'apple-touch-icon.png']) {
      assert.ok(fs.statSync(path.join(distRoot, file)).isFile(), `${short}/${file}`);
    }
    const html = fs.readFileSync(path.join(distRoot, 'index.html'), 'utf8');
    assert.match(html, /\/assets\//, `${short} keeps the original asset URL contract`);
    assert.ok(fs.statSync(path.join(distRoot, 'assets')).isDirectory(), `${short}/assets`);
  }

  assert.equal(fs.existsSync(path.join(root, 'monitor-themes', 'default', 'dist', 'dashboard.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'monitor-themes', 'serverstatus', 'dist', 'dashboard.html')), false);

  for (const config of ['wrangler.toml', '.github/workflows/deploy.yml']) {
    assert.match(fs.readFileSync(path.join(root, config), 'utf8'),
      /run_worker_first\s*=\s*true/);
  }
});

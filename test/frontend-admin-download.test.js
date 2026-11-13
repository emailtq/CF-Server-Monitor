import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('mounted download layout, switches and credential rotation ownership', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/download.mjs'], {
    encoding: 'utf8', windowsHide: true, timeout: 230000, env: process.env
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

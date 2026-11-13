import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('all mounted admin dialog consumers contain scroll edges and download switches animate', { timeout: 300000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/dialogs.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 290000, env: process.env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

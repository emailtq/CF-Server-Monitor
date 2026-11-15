import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('unlimited task dialogs, conditional native scrollbars and public charts work on touch and desktop in both themes', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/latency-tasks.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 230000, env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

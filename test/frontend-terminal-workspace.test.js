import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('mounted xterm normal touch history and terminal workspace preserve session/input authority', { timeout: 120000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-workspace.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 115000, env: process.env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

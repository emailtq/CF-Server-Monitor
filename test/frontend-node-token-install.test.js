import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('compiled download uses one stable node token with terminal off/on and preserves copy-only controls', {timeout:240000}, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/node-token-install.mjs'], {
    encoding:'utf8', windowsHide:true, timeout:240000, env:process.env
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

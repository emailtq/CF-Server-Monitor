import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const mode of ['themes', 'secrets']) {
  test(`Task4 correction2 real admin ${mode} edge cases`, () => {
    const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/correction2.mjs', mode], {
      encoding: 'utf8', timeout: 360000, windowsHide: true,
      env: { ...process.env, ADMIN_UI_CORRECTION2_REPORT_DIR: process.env.ADMIN_UI_CORRECTION2_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-4/correction-2/registered-browser' }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('single-page notifications and actual CDP touch picker/scroll behavior', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/stage2-touch.mjs'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('actual alert popup keeps active input entry through short/body scrolling without a focus handoff', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/dialogs.mjs', '--picker-scrollport'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, ADMIN_DIALOG_REPORT_DIR: process.env.STAGE2_REPORT_DIR ? path.join(process.env.STAGE2_REPORT_DIR, 'picker-scrollport') : '.planning/2026-11-13-admin-ui-refinement/successor/stage2/evidence/picker-scrollport' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const pointer of ['coarse', 'fine']) test(`real terminal ${pointer} wider thumb, diagonal tracking, history and ACK`, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-workspace.mjs'], { encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, TERMINAL_THUMB_ONLY: '1', TERMINAL_WORKSPACE_POINTER: pointer, TERMINAL_WORKSPACE_REPORT_DIR: process.env.STAGE2_REPORT_DIR ? path.join(process.env.STAGE2_REPORT_DIR, `terminal-${pointer}`) : `.planning/2026-11-13-admin-ui-refinement/successor/stage2/evidence/terminal-${pointer}` }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

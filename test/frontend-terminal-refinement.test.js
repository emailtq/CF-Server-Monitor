import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('real terminal connection transcript, native draft paste, menu motion and pointer thumb tracking', { timeout: 180000 }, () => {
  const env = { ...process.env, TERMINAL_REFINEMENT: '1' };
  if (env.TERMINAL_WORKSPACE_REPORT_DIR) env.TERMINAL_WORKSPACE_REPORT_DIR = path.join(env.TERMINAL_WORKSPACE_REPORT_DIR, 'refinement');
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-workspace.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 175000, env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

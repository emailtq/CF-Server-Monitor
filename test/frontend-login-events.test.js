import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

test('success-event add/edit uses real scope validation and renders core viewports/themes', { timeout: 180000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/login-events.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 175000,
    env: { ...process.env, LOGIN_EVENTS_REPORT_DIR: process.env.LOGIN_EVENTS_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', 'round4-events-terminal-registered', 'events') } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

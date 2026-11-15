import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('all-dialog edge layout and continuous actual CDP keyboard viewport keep focus and form width', { timeout: 180000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/dialogs.mjs', '--edge-keyboard'], { encoding: 'utf8', timeout: 170000, windowsHide: true, env: { ...process.env, ADMIN_DIALOG_REPORT_DIR: process.env.ADMIN_DIALOG_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `dialog-keyboard-${Date.now()}`) } });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('native dialog track begins below title and X while its painted thumb and full hit region drag', { timeout: 120000 }, () => {
  const root = process.env.ADMIN_DIALOG_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `dialog-track-${Date.now()}`);
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/dialogs.mjs', '--edge-keyboard', '--track-layout'], { encoding: 'utf8', timeout: 110000, windowsHide: true, env: { ...process.env, ADMIN_DIALOG_REPORT_DIR: path.join(root, 'track-layout') } });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

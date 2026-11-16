import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('all reachable admin pages and dialogs keep readable responsive fields and visible commands', { timeout: 360000 }, () => {
  const out = process.env.ADMIN_DESKTOP_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `desktop-${Date.now()}`);
  // Keep Chromium/D1 fixtures serial on memory-constrained Windows hosts.
  for (const [fixture, args, reportVariable] of [
    ['named-pages', ['--desktop-audit', '--layout-only'], 'NAMED_PAGES_REPORT_DIR'],
    ['dialogs', ['--desktop-layout'], 'ADMIN_DIALOG_REPORT_DIR']
  ]) {
    const result = spawnSync(process.execPath, [`test/fixtures/admin-ui/${fixture}.mjs`, ...args], {
      encoding: 'utf8', timeout: 170000, windowsHide: true,
      env: { ...process.env, [reportVariable]: path.join(out, fixture) }
    });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, `${fixture}: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  }
});

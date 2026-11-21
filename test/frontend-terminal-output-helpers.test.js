import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { terminalWebUrl } from '../src/frontend/utils/terminalOutput.js';

test('terminal URL policy permits normalized HTTP destinations, never credentials, controls or other protocols', () => {
  for (const [input, want] of [
    ['HTTPS://Example.com:443/a?q=1', 'https://example.com/a?q=1'],
    ['http://example.com', 'http://example.com/'],
    ['https://例え.jp/画面', 'https://xn--r8jz45g.jp/%E7%94%BB%E9%9D%A2'],
    ...['javascript:alert(1)', 'data:text/plain,bad', 'file:///tmp/a', 'ssh://example.com', 'https://user:password@example.com', 'https://user@example.com', 'https://[bad', 'https://example.com/\u202eevil', 'https://exa\nmple.com', 'https:\\example.com', '', null].map(value => [value, ''])
  ]) assert.equal(terminalWebUrl(input), want, String(input));
});

test('mounted xterm retained-output search, screen download and explicit safe web links', { timeout: 180000 }, () => {
  const env = { ...process.env, TERMINAL_OUTPUT_HELPERS_ONLY: '1' };
  const root = env.TERMINAL_WORKSPACE_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence');
  fs.mkdirSync(root, { recursive: true });
  env.TERMINAL_WORKSPACE_REPORT_DIR = fs.mkdtempSync(path.join(root, 'terminal-output-'));
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-workspace.mjs'], { encoding: 'utf8', windowsHide: true, timeout: 175000, env });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

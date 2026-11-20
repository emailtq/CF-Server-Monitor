import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMonitorVars } from '../scripts/monitor-theme-vars.mjs';

test('unset variables leave the generated config unchanged', () => {
  assert.equal(renderMonitorVars({}), '');
  assert.equal(renderMonitorVars({ host: '', theme: '' }), '');
});

test('host defaults to the bundled default theme and emits TOML vars', () => {
  assert.equal(renderMonitorVars({ host: 'status.example.com' }),
    'MONITOR_COMPAT_HOST = "status.example.com"\nMONITOR_COMPAT_THEME = "default"\n');
  assert.equal(renderMonitorVars({ host: 'status.example.com', theme: 'serverstatus' }),
    'MONITOR_COMPAT_HOST = "status.example.com"\nMONITOR_COMPAT_THEME = "serverstatus"\n');
});

test('invalid or incomplete variables fail closed', () => {
  for (const host of ['https://status.example.com', 'status.example.com:443', '*.example.com', 'status_example.com', 'localhost', '127.0.0.1', 'status.example.com ']) {
    assert.throws(() => renderMonitorVars({ host }), /MONITOR_COMPAT_HOST/);
  }
  assert.throws(() => renderMonitorVars({ theme: 'default' }), /MONITOR_COMPAT_THEME/);
  assert.throws(() => renderMonitorVars({ host: 'status.example.com', theme: 'other' }), /MONITOR_COMPAT_THEME/);
});

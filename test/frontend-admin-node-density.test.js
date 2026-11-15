import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('admin address display preserves IPv4 and IPv6 endpoints without changing full copy values', async () => {
  const metadata = await import('../src/frontend/views/admin/components/serverMetadata.js');
  assert.equal(typeof metadata.formatAdminAddress, 'function');
  for (const [address, expected] of [
    ['192.0.2.1', '192.0.2.1'], ['2001:db8::1', '2001:db8::1'],
    ['2001:db8:abcd:1234:5678:90ab:cdef:1234', '2001:db8…cdef:1234'],
    ['2001:db8:abcd:1234::1234', '2001:db8…1234::1234'],
    ['2001:db8:abcd:1234:123', '2001:db8:abcd:1234:123'],
    ['2001:db8:abcd:1234:1234', '2001:db8…1234:1234'],
    ['2001:db8:abcd:1234:1234::', '2001:db8…1234:1234::'],
    ['::abcd:1234:5678:cdef:1234', '::abcd:1234…cdef:1234'],
    ['2001:db8:1234::192.0.2.1', '2001:db8:1234::192.0.2.1']
  ]) assert.equal(metadata.formatAdminAddress(address), expected, address);
});

test('mounted node rows keep compact address lines, intrinsic height and copy/drag/touch access', { timeout: 180000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/node-density.mjs'], {
    encoding: 'utf8', timeout: 170000, windowsHide: true, env: process.env
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

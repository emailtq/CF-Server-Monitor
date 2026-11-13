import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('mounted admin node ordering, save ownership and responsive reference geometry', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/reorder.mjs'], {
    encoding: 'utf8', timeout: 230000, env: process.env
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

test('admin OS metadata uses explicit product release only; shared OS naming and actual region authority stay intact', async () => {
  const { formatAdminOS, getAdminCountryCode } = await import('../src/frontend/views/admin/components/serverMetadata.js');
  const { getOSName } = await import('../src/frontend/utils/osIcon.js');
  for (const [raw, expected] of [
    ['Debian GNU/Linux 13 (trixie)', 'Debian 13'], ['Debian GNU/Linux 12 (bookworm)', 'Debian 12'],
    ['Ubuntu 24.04.3 LTS', 'Ubuntu 24'], ['Ubuntu 22.04.5 LTS Linux 6.8.0-101', 'Ubuntu 22'],
    ['Windows Server 2025', 'Windows Server 2025'], ['Microsoft Windows Server 2022 build 20348', 'Windows Server 2022'],
    ['Windows 11 build 26100', 'Windows 11'], ['macOS 15.2.1', 'macOS 15'], ['Mac OS X 10.15.7', 'macOS 10'],
    ['Darwin 24.2.0', 'macOS'], ['Linux 6.8.0-101 generic build 42', 'Linux'],
    ['Debian GNU/Linux kernel 6.8.0 build 13', 'Debian'], ['Ubuntu build 2404 kernel 6.8', 'Ubuntu'],
    ['MysteryOS 7.3 build 12', 'MysteryOS'], ['Debian GNU/Linux (trixie)', 'Debian'],
    ['Alpine Linux v3.21.2', 'Alpine Linux 3'], ['Fedora Linux 42', 'Fedora 42'], ['', 'Unknown'], [null, 'Unknown'],
    ['Red Hat Enterprise Linux 9.6 (Plow)', 'Red Hat 9'], ['CentOS Stream 9', 'CentOS 9'],
    ['Oracle Linux Server 9.6', 'Oracle Linux 9'], ['openSUSE Leap 15.6', 'openSUSE 15'],
    ['CentOS Linux 7 (Core)', 'CentOS 7'], ['Rocky Linux 9.6 (Blue Onyx)', 'Rocky Linux 9'],
    ['Fedora Linux 42 (Workstation Edition)', 'Fedora 42'], ['openSUSE Tumbleweed', 'openSUSE'],
    ['Red Hat Enterprise Linux kernel 5.14 build 9', 'Red Hat'], ['CentOS Stream kernel 6.8 build 9', 'CentOS'],
    ['Oracle Linux Server build 9 kernel 6.8', 'Oracle Linux'], ['openSUSE Leap kernel 6.8 build 15', 'openSUSE']
  ]) assert.equal(formatAdminOS(raw), expected, raw);
  assert.equal(getOSName('Ubuntu 24.04.3 LTS'), 'Ubuntu', 'public OS helper contract is not changed');
  for (const [raw, expected] of [['hk', 'HK'], [' JP ', 'JP'], ['uk', 'GB'], ['GB', 'GB'], ['TW', 'TW'], ['', ''], [null, ''], ['xx', ''], ['zz', ''], ['AA', ''], ['not-a-region', '']]) assert.equal(getAdminCountryCode(raw), expected, String(raw));
});

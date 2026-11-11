import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as sources from '../src/shared/agentSource.js';

const admin = readFileSync(new URL('../src/frontend/views/admin/index.vue', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const releaseUrl = 'https://api.github.com/repos/emailtq/cfsm-agent/releases/latest';
const rawSh = 'https://raw.githubusercontent.com/emailtq/cfsm-agent/terminal/install.sh';
const rawPs = 'https://raw.githubusercontent.com/emailtq/cfsm-agent/terminal/install.ps1';

function declaration(name) {
  const start = admin.indexOf(`const ${name} =`);
  const end = admin.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, name);
  return admin.slice(start, end + 2);
}

function commands(overrides = {}) {
  const context = vm.createContext({
    ...sources,
    selectedApiBase: { value: 'https://monitor.invalid' },
    copyServerId: { value: 'node-source-test' }, apiSecret: { value: 'synthetic-report-secret' },
    targetOs: { value: 'linux' }, installMode: { value: 'current-user' },
    installVersion: { value: 'latest' }, installGhProxy: { value: '' }, autoUpdate: { value: true },
    installCommandBlocked: { value: false }, terminalInstallOptions: { value: { selected: false, enabled: false, tokenFile: '' } },
    settings: { value: { ua: 'cfsm' } }, trans: { value: {} },
    deleteVersion: { value: 'go' }, deleteTargetOs: { value: 'linux' },
    deleteInstallMode: { value: 'current-user' }, deleteGhProxy: { value: '' },
    ...overrides
  });
  const start = admin.indexOf('const buildGhRawUrl =');
  const end = admin.indexOf('const getAutoDiscoveryInstallCommand =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(admin.slice(start, end) + '\n' + declaration('getUninstallCommand'), context);
  return {
    install: () => vm.runInContext('getCustomInstallCommand()', context),
    uninstall: () => vm.runInContext('getUninstallCommand()', context),
    discover: options => vm.runInContext('buildAutoDiscoveryCommand(' + JSON.stringify(options) + ')', context)
  };
}

for (const [os, url] of [['linux', rawSh], ['unix', rawSh], ['mac', rawSh], ['windows', rawPs]]) {
  test(`${os} installation downloads the confirmed terminal-branch installer`, () => {
    const command = commands({ targetOs: { value: os } }).install();
    assert.ok(command.includes(url), command);
    assert.ok(command.includes('synthetic-report-secret'));
    assert.ok(!command.includes('huilang-me/cfsm-agent'));
  });
  test(`${os} Go uninstallation downloads the same confirmed installer`, () => {
    const command = commands({ deleteTargetOs: { value: os } }).uninstall();
    assert.ok(command.includes(url), command);
    assert.ok(command.includes('uninstall'));
    assert.ok(!command.includes('synthetic-report-secret'));
  });
}

test('Docker monitoring uses the confirmed image owner and keeps terminal off', () => {
  const command = commands({ targetOs: { value: 'docker' } }).install();
  assert.ok(command.includes('ghcr.io/emailtq/cfsm-agent:latest'), command);
  assert.ok(command.includes('TERMINAL_ENABLED=0'));
  assert.ok(command.includes('synthetic-report-secret'));
});

test('proxy installation and uninstallation wrap the confirmed raw source', () => {
  const c = commands({ installGhProxy: { value: 'https://proxy.invalid/' }, deleteGhProxy: { value: 'https://proxy.invalid/' } });
  const expected = 'https://proxy.invalid/https://raw.githubusercontent.com/emailtq/cfsm-agent/terminal/install.sh';
  assert.ok(c.install().includes(expected));
  assert.ok(c.uninstall().includes(expected));
});

test('dedicated-user installation keeps its wrapper around the confirmed installer', () => {
  const command = commands({ installMode: { value: 'cfsm-user' } }).install();
  assert.ok(command.includes(rawSh));
  assert.ok(command.includes('runuser -u cfsm'));
  assert.ok(command.includes('loginctl enable-linger cfsm'));
});

test('dedicated-user uninstallation keeps its wrapper without reporting credentials', () => {
  const command = commands({ deleteInstallMode: { value: 'cfsm-user' } }).uninstall();
  assert.ok(command.includes(rawSh));
  assert.ok(command.includes('runuser -u cfsm'));
  assert.ok(command.includes('uninstall'));
  assert.ok(!command.includes('synthetic-report-secret'));
});

test('auto-discovery uses confirmed scripts for native and PowerShell commands', () => {
  const c = commands();
  assert.ok(c.discover({ targetOs: 'linux', name: 'synthetic-node' }).includes(rawSh));
  assert.ok(c.discover({ targetOs: 'windows', ghProxy: 'https://proxy.invalid/' }).includes('https://proxy.invalid/' + rawPs));
});

test('legacy Python uninstall stays on the selected Worker, without Go credentials', () => {
  const c = commands({ deleteVersion: { value: 'python' } });
  assert.equal(c.uninstall(), "curl -fsSL 'https://monitor.invalid/uninstall.sh' | sh -s");
});

test('frontend latest-version lookup calls the confirmed release API', async () => {
  const requests = [];
  const literal = admin.match(/const AGENT_RELEASE_URL = '([^']+)'/)?.[1];
  const context = vm.createContext({
    ...sources, ...(literal ? { AGENT_RELEASE_URL: literal } : {}),
    fetch: async url => {
      requests.push(url);
      return url === releaseUrl ? Response.json({ tag_name: 'v9.8.7' }) : new Response('', { status: 404 });
    }
  });
  vm.runInContext("const AGENT_RELEASE_FAILURE_TTL = 30000; let cachedAgentReleaseVersion = ''; let cachedAgentReleaseFailureAt = 0; let agentReleasePromise = null; const normalizeVersion = value => String(value || '').trim();\n" + declaration('fetchLatestAgentReleaseVersion'), context);
  assert.equal(await vm.runInContext('fetchLatestAgentReleaseVersion()', context), 'v9.8.7');
  assert.deepEqual(requests, [releaseUrl]);
});

for (const missing of [false, true]) {
  test(`backend version lookup ${missing ? 'reports a missing Release without upstream fallback' : 'uses the confirmed release API'}`, async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async url => {
      requests.push(url);
      if (url === releaseUrl) return missing ? new Response('', { status: 404 }) : Response.json({ tag_name: 'v9.8.7' });
      if (url === 'https://raw.githubusercontent.com/huilang-me/CF-Server-Monitor/refs/heads/main/version.json') return Response.json({ workers: '2.8.6' });
      return new Response('', { status: 404 });
    };
    try {
      const { getRemoteVersion } = await import(`../src/utils/version.js?source-check=${missing}`);
      const result = await getRemoteVersion();
      assert.equal(result.agent, missing ? '' : 'v9.8.7');
      assert.equal(result.workers, '2.8.6');
      assert.ok(requests.includes(releaseUrl));
      assert.ok(!requests.some(url => url.includes('huilang-me/cfsm-agent')));
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const locale of ['zh', 'zh-TW', 'en', 'ja', 'fr', 'es', 'id']) {
  test(`${locale} version help directs users to the confirmed Agent releases`, async () => {
    const { default: translations } = await import(`../src/frontend/locales/${locale}.js`);
    const destination = translations.installVersionTip.match(/https:\/\/github\.com\/[^\s]+/)?.[0];
    assert.equal(destination, 'https://github.com/emailtq/cfsm-agent/releases');
  });
}

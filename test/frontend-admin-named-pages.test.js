import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('Worker terminal version source stays separate from Agent releases and retains partial/failure cache', async t => {
  const worker = 'https://raw.githubusercontent.com/emailtq/CF-Server-Monitor/refs/heads/terminal/version.json';
  const agent = 'https://api.github.com/repos/emailtq/cfsm-agent/releases/latest';
  let clock = 1000000, mode = 'success', calls = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (mode === 'fail' || mode === 'worker-only' && url === agent) return new Response('', { status: 503 });
    if (url === worker) return Response.json({ workers: '2.8.7 Beta6', agent: '1.1.1' });
    if (url === agent) return Response.json({ tag_name: ' v9.8.7 ' });
    return new Response('', { status: 404 });
  });
  const { getRemoteVersion } = await import(`../src/utils/version.js?named-pages=${Date.now()}`);
  const expected = { workers: '2.8.7 Beta6', agent: 'v9.8.7' };
  assert.deepEqual(await getRemoteVersion(), expected);
  assert.deepEqual(calls, [worker, agent]);
  await getRemoteVersion(); assert.equal(calls.length, 2, 'ten-minute cache');
  clock += 600001; mode = 'worker-only'; assert.deepEqual(await getRemoteVersion(), expected, 'partial response preserves last known Agent');
  clock += 600001; mode = 'fail'; assert.deepEqual(await getRemoteVersion(), expected, 'failure preserves usable versions');
  const afterFailure = calls.length;
  await getRemoteVersion(); assert.equal(calls.length, afterFailure, 'failure TTL suppresses retry storm');
  clock += 30001; mode = 'success'; assert.deepEqual(await getRemoteVersion(), expected); assert.equal(calls.length, afterFailure + 2);
});

test('named admin pages fit long labels and inset eyes preserve actual input selection with D1 actions', { timeout: 240000 }, () => {
  const out = process.env.NAMED_PAGES_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `round4-named-pages-${Date.now()}`);
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/named-pages.mjs'], { encoding: 'utf8', timeout: 230000, windowsHide: true, env: { ...process.env, NAMED_PAGES_REPORT_DIR: out } });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
});

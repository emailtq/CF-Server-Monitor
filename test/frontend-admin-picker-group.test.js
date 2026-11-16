import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

async function loadStartupLifecycle(filename, bindings) {
  const key = `pickerStartup_${crypto.randomUUID()}`;
  globalThis[key] = bindings;
  // Inject failed startup dependencies only; execute the fixture's actual cleanup control flow.
  const source = (await fs.readFile(filename, 'utf8')).replace(/^import .*;\r?\n/gm, '');
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(`const { ${Object.keys(bindings).join(', ')} } = globalThis[${JSON.stringify(key)}];\n${source}`).toString('base64')}`);
  } finally { delete globalThis[key]; }
}

test('failed second D1 harness disposes the first and preserves the startup error', async () => {
  const failure = new Error('injected second runtime write EOF'), disposed = [];
  let starts = 0;
  const { pickerGroupD1 } = await loadStartupLifecycle('test/fixtures/admin-ui/picker-group-d1.mjs', {
    assert, harness: async () => { if (++starts === 2) throw failure; return { dispose: async () => { disposed.push('a'); } }; }
  });
  await assert.rejects(pickerGroupD1({ setTransport() {}, report: {} }), error => error === failure);
  assert.deepEqual(disposed, ['a']);
});

test('failed D1 startup disposes the just-created Miniflare before returning the original error', async () => {
  for (const cleanup of ['success', 'ready-error-rethrow', 'distinct-error']) {
    const failure = new Error('injected config-pipe write EOF'), cleanupFailure = new Error('injected cleanup failure');
    let disposed = false;
    const { harness } = await loadStartupLifecycle('test/terminal-harness.js', {
      build: async () => ({ outputFiles: [{ text: 'startup fixture' }] }),
      clearSiteSettingsCache() {},
      Miniflare: class {
        async getD1Database() { throw failure; }
        async dispose() { disposed = true; if (cleanup !== 'success') throw cleanup === 'ready-error-rethrow' ? failure : cleanupFailure; }
      }
    });
    await assert.rejects(harness(), error => error === failure);
    assert.equal(disposed, true);
    assert.equal(failure.harnessPhase, 'runtime-start');
    assert.equal(failure.cleanupError, cleanup === 'distinct-error' ? cleanupFailure : undefined);
  }
});

test('input-owned alert pickers and edit groups keep focus, IME, touch and real D1 save ownership', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/picker-group.mjs'], {
    encoding: 'utf8', timeout: 230000, windowsHide: true,
    env: { ...process.env, PICKER_GROUP_REPORT_DIR: process.env.PICKER_GROUP_REPORT_DIR || path.join(os.tmpdir(), 'cfsm-admin-ui-evidence', `round5-picker-${Date.now()}`) }
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error || ''));
});

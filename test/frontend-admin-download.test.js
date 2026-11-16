import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyTextToClipboard } from '../src/frontend/utils/clipboard.js';

test('clipboard reports actual results without stealing input or terminal selection', async () => {
  const originals = Object.fromEntries(['window', 'navigator', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let listener, writes = [], calls = 0;
  const activeElement = { selectionStart: 2, selectionEnd: 5 };
  const document = {
    activeElement,
    addEventListener: (name, fn) => { assert.equal(name, 'copy'); listener = fn; },
    removeEventListener: (name, fn) => { assert.equal(name, 'copy'); assert.equal(fn, listener); listener = null; },
    execCommand: name => {
      calls++; assert.equal(name, 'copy');
      listener({ clipboardData: { setData: (type, text) => { assert.equal(type, 'text/plain'); writes.push(text); } }, preventDefault: () => {} });
      return true;
    }
  };
  const set = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, value });
  try {
    set('window', { location: { protocol: 'http:' } }); set('navigator', {}); set('document', document);
    assert.equal(await copyTextToClipboard('terminal selection'), true);
    assert.deepEqual(writes, ['terminal selection']); assert.equal(listener, null);
    assert.equal(document.activeElement, activeElement); assert.equal(activeElement.selectionStart, 2); assert.equal(activeElement.selectionEnd, 5);
    document.execCommand = () => false;
    assert.equal(await copyTextToClipboard('no permission'), false); assert.equal(listener, null);
    document.execCommand = () => { throw new Error('denied'); };
    assert.equal(await copyTextToClipboard('failed'), false); assert.equal(listener, null);
    set('navigator', { clipboard: { writeText: async text => { writes.push(text); } } });
    assert.equal(await copyTextToClipboard('secure'), true); assert.equal(writes.at(-1), 'secure');
    set('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    assert.equal(await copyTextToClipboard('rejected'), false); assert.equal(calls, 1, 'writeText denial must not be hidden by a fallback');
  } finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('mounted download layout, switches and credential rotation ownership', { timeout: 240000 }, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/download.mjs'], {
    encoding: 'utf8', windowsHide: true, timeout: 230000, env: process.env
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

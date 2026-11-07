import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  validateTerminalSize,
  validateTerminalDataFrame,
  parseTerminalControl
} from '../src/shared/terminalProtocol.js';

test('terminal dimensions accept only integers from 1 through 500', () => {
  assert.equal(validateTerminalSize(80, 24), true);
  assert.equal(validateTerminalSize(1, 500), true);
  for (const value of [0, -1, 1.5, '80', 501, null, NaN, Infinity]) {
    assert.equal(validateTerminalSize(value, 24), false);
    assert.equal(validateTerminalSize(80, value), false);
  }
});

test('terminal binary frames enforce the 16 KiB boundary without treating text as input', () => {
  assert.equal(validateTerminalDataFrame(new ArrayBuffer(16384)), true);
  assert.equal(validateTerminalDataFrame(new Uint8Array(16384)), true);
  assert.equal(validateTerminalDataFrame(new Uint8Array(16385)), false);
  assert.equal(validateTerminalDataFrame(new ArrayBuffer(16385)), false);
  assert.equal(validateTerminalDataFrame('{"type":"resize","cols":80,"rows":24}'), false);
});

const frames = [
  ['agent-control', { type: 'hello', protocol: 1, platform: 'linux', capabilities: ['terminal.pty.v1'] }],
  ['broker-control', { type: 'open', protocol: 1, sessionId: 'session-1', ticket: 'a'.repeat(64), cols: 80, rows: 24 }],
  ['broker-control', { type: 'close', sessionId: 'session-1', reason: 'user_close' }],
  ['broker', { type: 'start', cols: 80, rows: 24 }],
  ['agent', { type: 'ready' }],
  ['browser', { type: 'resize', cols: 120, rows: 40 }],
  ['broker', { type: 'resize', cols: 120, rows: 40 }],
  ['browser', { type: 'ack', bytes: 4096 }],
  ['agent', { type: 'ack', bytes: 4096 }],
  ['broker', { type: 'ack', bytes: 4096 }],
  ['agent', { type: 'exit', code: 0 }],
  ['broker', { type: 'exit', code: -1 }],
  ['agent', { type: 'error', code: 'pty_start_failed' }],
  ['broker', { type: 'ready' }],
  ['broker', { type: 'error', code: 'auth_expired' }]
];

test('terminal controls preserve the documented frames for their sender role', () => {
  for (const [role, frame] of frames) {
    assert.deepEqual(parseTerminalControl(JSON.stringify(frame), role), frame);
  }
  for (const role of ['agent-control', 'broker-control', 'browser', 'agent', 'broker']) {
    assert.deepEqual(parseTerminalControl('{"type":"ping"}', role), { type: 'ping' });
    assert.deepEqual(parseTerminalControl('{"type":"pong"}', role), { type: 'pong' });
  }
});

test('terminal controls reject unknown roles, type confusion and sender impersonation', () => {
  for (const [role, frame] of [
    ['browser', { type: 'start', cols: 80, rows: 24 }],
    ['browser', { type: 'ready' }],
    ['browser', { type: 'exit', code: 0 }],
    ['agent', { type: 'resize', cols: 80, rows: 24 }],
    ['agent-control', frames[1][1]],
    ['broker-control', frames[0][1]],
    ['browser', { type: 'command', command: 'ls' }],
    ['unknown', { type: 'ping' }],
    ['browser', { type: 'ping', serverId: 'other-node' }],
    ['browser', { type: 'resize', cols: '80', rows: 24 }],
    ['broker', { type: 'start', cols: 80, rows: 501 }],
    ['agent', { type: 'ack', bytes: -1 }],
    ['agent', { type: 'ack', bytes: 1.5 }],
    ['browser', { type: 'ack', bytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['agent', { type: 'exit', code: 256 }],
    ['agent', { type: 'error', code: 'raw shell output\n' }],
    ['agent-control', { ...frames[0][1], protocol: 2 }],
    ['agent-control', { ...frames[0][1], capabilities: ['command.rpc'] }],
    ['broker-control', { ...frames[1][1], ticket: 'bad-ticket' }],
    ['broker-control', { ...frames[1][1], sessionId: '' }]
  ]) {
    assert.throws(() => parseTerminalControl(JSON.stringify(frame), role), RangeError);
  }
  for (const text of ['null', '[]', '1', '"input"', '{', '{}']) {
    assert.throws(() => parseTerminalControl(text, 'browser'), RangeError);
  }
  assert.throws(() => parseTerminalControl(new Uint8Array(1), 'browser'), RangeError);
});

test('terminal control size is bounded in UTF-8 bytes before parsing', () => {
  const prefix = '{"type":"ping"}';
  assert.deepEqual(parseTerminalControl(prefix.padEnd(4096), 'browser'), { type: 'ping' });
  assert.throws(() => parseTerminalControl(prefix.padEnd(4097), 'browser'), RangeError);
  // Non-ASCII text cannot sneak past a JavaScript character-count bound.
  assert.throws(() => parseTerminalControl('{"type":"error","code":"' + '\u00e9'.repeat(2050) + '"}', 'agent'), RangeError);
});

test('existing deployment CI gates release with full regressions and preserves additive DO migrations', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const deploy = read('.github/workflows/deploy.yml');
  assert.match(deploy, /pull_request:/);
  assert.match(deploy, /verify:[\s\S]*npm ci[\s\S]*npm run test:all[\s\S]*npm run build:frontend[\s\S]*npm run build:github-page/);
  assert.match(deploy, /needs: \[check, verify\]/);
  for (const config of [read('wrangler.toml'), deploy]) {
    assert.match(config, /tag = "v1"\s+new_sqlite_classes = \["MetricsBroadcaster"\]/);
    assert.match(config, /name = "TERMINAL_BROKER"\s+class_name = "TerminalBroker"/);
    assert.match(config, /tag = "terminal-v1"\s+new_sqlite_classes = \["TerminalBroker"\]/);
  }
  const pages = read('.github/workflows/deploy-github-page.yml');
  assert.match(pages, /npm ci[\s\S]*npm run test:all[\s\S]*npm run build:github-page/);
});

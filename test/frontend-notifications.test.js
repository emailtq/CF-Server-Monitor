import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { channelPayload, newChannel, previewMessage } from '../src/frontend/views/admin/composables/notificationPresentation.js';

test('local preview preserves double-brace semantics and actual empty-render message fallback', () => {
  const trans = { adminPreviewEvent: 'fixture event', adminPreviewMessage: 'fixture message', adminPreviewClient: 'fixture client' };
  assert.equal(previewMessage('{{unknown}}', trans), 'fixture message');
  assert.equal(previewMessage('{{notification}}', trans), 'fixture message');
  assert.equal(previewMessage('<b>{{ message }}</b> {message}', trans), '<b>fixture message</b> {message}');
});

test('typed provider addresses become real backend tokens without requiring users to memorize prefixes', () => {
  for (const [type, prefix] of [['onebot', 'onebot:'], ['bark', 'bark:'], ['serverchan', 'server:']]) {
    const draft = { ...newChannel(type), secrets: { token: 'https://fixture.invalid/send' } };
    assert.equal(channelPayload(draft).secrets.token, prefix + 'https://fixture.invalid/send');
    draft.secrets.token = prefix + 'https://fixture.invalid/send';
    assert.equal(channelPayload(draft).secrets.token, prefix + 'https://fixture.invalid/send');
    draft.secrets.token = '';
    assert.equal(Object.hasOwn(channelPayload(draft), 'secrets'), false);
  }
});

test('Task5 notification and alert components compile as actual Vue templates', () => {
  for (const name of ['AdminNotifications', 'AdminAlerts', 'NotificationDialog', 'AlertDialog', 'NotificationWorkspace']) {
    const filename = `src/frontend/views/admin/components/${name}.vue`;
    const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'));
    assert.deepEqual(errors, [], name);
    const script = compileScript(descriptor, { id: name });
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: name, compilerOptions: { bindingMetadata: script.bindings } }).errors, [], name);
  }
});

test('Task5 real Vue wizard and alerts use isolated authenticated D1 and explicit transports', () => {
  const result = spawnSync(process.execPath, ['--import', './test/fixtures/admin-ui/notification-preload.mjs', 'test/fixtures/admin-ui/notifications.mjs'], {
    encoding: 'utf8', timeout: 360000, windowsHide: true,
    env: { ...process.env, TASK5_REPORT_DIR: process.env.TASK5_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/registered' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('real Vue provider transition preserves common draft and discards old credentials', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/notification-provider.mjs'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, TASK5_PROVIDER_REPORT_DIR: process.env.TASK5_PROVIDER_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/final-2/registered-provider' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const mode of ['picker', 'scopes', 'boundary-stale', 'boundary-error', 'boundary-malformed', 'boundary-config-error']) {
  test(`Task5 scope repair real Vue ${mode} behavior`, () => {
    const result = spawnSync(process.execPath, ['--import', './test/fixtures/admin-ui/notification-preload.mjs', 'test/fixtures/admin-ui/notification-scope.mjs', mode], {
      encoding: 'utf8', timeout: 360000, windowsHide: true,
      env: { ...process.env, TASK5_SCOPE_REPORT_DIR: process.env.TASK5_SCOPE_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/scope-repair-1/registered' }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('long localized notification footer retains accessible Cancel and real primary targets', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/notification-matrix.mjs', 'fr', '--footer'], {
    encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: { ...process.env, TASK5_MATRIX_REPORT_DIR: process.env.TASK5_MATRIX_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/final-1/registered-footer' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('real Vue localized wizard glyphs stay visible without changing step semantics', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/notification-labels.mjs'], {
    encoding: 'utf8', timeout: 360000, windowsHide: true,
    env: { ...process.env, TASK5_LABEL_REPORT_DIR: process.env.TASK5_LABEL_REPORT_DIR || 'docs/superpowers/admin-ui-refactor/evidence/task-5/final-4/registered-labels' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

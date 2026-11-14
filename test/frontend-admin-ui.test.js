import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { spawnSync } from 'node:child_process';

test('collection settings remain editable on small and short screens in the complete admin', () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/latency.mjs'], {
    encoding: 'utf8', timeout: 360000, windowsHide: true, env: process.env
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

const base = 'src/frontend/views/admin/components/';
for (const name of ['AdminHeader', 'AdminLayout', 'AdminDialog', 'AdminMultiSelect']) {
  test(`${name} compiles as a real Vue component`, () => {
    const source = fs.readFileSync(`${base}${name}.vue`, 'utf8');
    const { descriptor, errors } = parse(source);
    assert.deepEqual(errors, []);
    const script = compileScript(descriptor, { id: name });
    const compiled = compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: name, compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(compiled.errors, []);
  });
}
test('admin stylesheet cannot target public UI without an admin boundary', () => {
  const css = postcss.parse(fs.readFileSync('src/frontend/styles/admin.css', 'utf8'));
  css.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) assert.match(selector, /\.admin-ui(?:\b|[\s.:[>])|\.admin-ui-surface\b/, selector);
  });
});
test('download stylesheet stays isolated from public UI and other accepted dialogs', () => {
  const css = postcss.parse(fs.readFileSync('src/frontend/styles/admin-download.css', 'utf8'));
  const checkRule = rule => {
    if (rule.parent.type === 'atrule' && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      assert.match(selector, /\.admin-ui\b/);
      assert.match(selector, /download/);
      assert.doesNotMatch(selector, /admin-dialog-(?:add|edit)|body\.light/);
    }
  };
  css.walkRules(checkRule);
  for (const selector of ['.download-unscoped', '.admin-ui .unrelated', '.admin-ui .admin-dialog-add .download-copy']) {
    assert.throws(() => postcss.parse(`${selector} { color: red; }`).walkRules(checkRule), { code: 'ERR_ASSERTION' });
  }
});
test('all existing admin dialog consumers compile after container migration', () => {
  for (const name of ['EditServerModal', 'BatchEditServersModal', 'DeleteServerModal', 'CopyCommandModal', 'AutoDiscoveryCommandModal', 'TerminalAccessModal']) {
    const { descriptor, errors } = parse(fs.readFileSync(`${base}${name}.vue`, 'utf8'));
    assert.deepEqual(errors, []);
    assert.match(descriptor.template.content, /<AdminDialog\b/, name);
    const script = compileScript(descriptor, { id: name });
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: `${name}.vue`, id: name, compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
  }
});
test('admin orchestrator compiles with the existing business handlers and new shell', () => {
  const { descriptor, errors } = parse(fs.readFileSync('src/frontend/views/admin/index.vue', 'utf8'));
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: 'admin' });
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'admin.vue', id: 'admin', compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
});

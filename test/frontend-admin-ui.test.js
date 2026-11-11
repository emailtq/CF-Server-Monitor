import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import postcss from 'postcss';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';

test('public cards keep each API site’s canonical or legacy latency mode', async () => {
  const vite=await createServer({configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true}});
  const previous=globalThis.localStorage;
  globalThis.localStorage={getItem:()=>null};
  try {
    const {useServerCardData}=await vite.ssrLoadModule('/src/frontend/composables/useServerCardData.js');
    const extra_ping_nodes=[{id:'p_task',name:'Canonical'}];
    const canonical=useServerCardData({server:{latency_tasks_active:true,extra_ping_nodes,ping_ct:11,ping_extra_p_task:22},sysConfig:{latency_tasks_active:false}});
    assert.deepEqual(canonical.pingList.value.map(item=>item.label),['Canonical']);
    const legacy=useServerCardData({server:{latency_tasks_active:false,extra_ping_nodes:[],ping_ct:11},sysConfig:{latency_tasks_active:true}});
    assert.ok(legacy.pingList.value.some(item=>item.label==='CT'));
  } finally {globalThis.localStorage=previous;await vite.close();}
});

test('non-latency collection controls belong to Settings, not the task manager', () => {
  const panel = fs.readFileSync('src/frontend/views/admin/components/SettingsPanel.vue', 'utf8');
  const collection = fs.readFileSync('src/frontend/views/admin/components/CollectionSettings.vue', 'utf8');
  const { descriptor } = parse(panel);
  const stack = [descriptor.template.ast];
  let collectionInSettings = false;
  while (stack.length) {
    const node = stack.pop();
    if (node.tag === 'div' && node.props.some(p => p.type === 7 && p.name === 'show' && p.exp?.content === "activeTab === 'settings'")) {
      collectionInSettings ||= node.children.some(child => child.tag === 'CollectionSettings');
    }
    if (node.children) stack.push(...node.children);
  }
  assert.ok(collectionInSettings, 'the collection component is inside the Settings-only group');
  assert.doesNotMatch(collection, /ping-node-grid|visiblePingFields|extra_ping_nodes/);
  for (const field of ['wss_report_enabled', 'frontend_ws_timeout_minutes', 'long_history_points']) assert.ok(collection.includes(field));
});

const base = 'src/frontend/views/admin/components/';
for (const name of ['AdminHeader', 'AdminLayout', 'AdminDialog', 'AdminMultiSelect', 'LatencyTasks', 'LatencyNotice']) {
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

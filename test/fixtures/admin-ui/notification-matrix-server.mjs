import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { build, preview } from 'vite';

// Compile fixture assets first; an explicit D1 hook keeps its original live middleware.
export async function createServer(options) {
  const root = fs.realpathSync(process.cwd()), out = path.dirname(options.cacheDir);
  const realOut = fs.realpathSync(out), evidence = path.join(root, 'docs/superpowers/admin-ui-refactor/evidence');
  assert.equal(path.resolve(out).toLowerCase(), realOut.toLowerCase(), 'fixture output must not traverse links');
  const relative = path.relative(evidence, realOut);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture output must stay in task evidence');
  const bundle = fs.mkdtempSync(path.join(realOut, 'compiled-fixture-'));
  assert.equal(path.dirname(fs.realpathSync(bundle)), realOut);
  const entry = path.join(root, 'test/fixtures/admin-ui/index.html');
  const entrySHA256 = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
  const startedAt = Date.now();
  const common = { configFile: false, envDir: false, root };
  const modules = options.frontendExports ? ['src/frontend/utils/i18n.js', 'src/frontend/composables/useTheme.js', 'src/frontend/utils/themeOptions.js'] : [];
  const input = [entry, ...modules.map(file => path.join(root, file)), ...(options.fixtureEntries || [])];
  assert.ok(input.every(file => fs.realpathSync(file).startsWith(root + path.sep)), 'fixture entries must remain in the workspace');
  // Existing fixture top-level awaits target installed modern Chromium, not production builds.
  const middleware = options.apiMiddlewarePlugin;
  if (middleware) assert.equal(typeof middleware.configureServer, 'function');
  const built = await build({ ...common, ...(options.vueFixtureDevtools ? { define: { __VUE_PROD_DEVTOOLS__: 'true' } } : {}), base: '/', cacheDir: path.join(bundle, 'cache'), plugins: options.plugins.filter(plugin => plugin !== middleware), publicDir: options.publicDir, build: { outDir: bundle, emptyOutDir: false, target: 'esnext', rollupOptions: { input, ...(modules.length ? { preserveEntrySignatures: 'strict' } : {}) } } });
  const chunks = (Array.isArray(built) ? built : [built]).flatMap(result => result.output || []);
  const exports = Object.fromEntries(modules.map(file => {
    const chunk = chunks.find(item => item.type === 'chunk' && item.facadeModuleId && path.resolve(item.facadeModuleId) === path.join(root, file));
    assert.ok(chunk, `missing real source module export: ${file}`);
    return [`/${file}`, `/${chunk.fileName}`];
  }));
  const server = await preview({ ...common, build: { outDir: bundle }, preview: { host: '127.0.0.1', port: 0 }, plugins: [...(middleware ? [{ name: 'actual-d1-preview-middleware', configurePreviewServer: middleware.configureServer }] : []), { name: 'fixture-real-source-exports', configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
      if (exports[pathname]) { response.statusCode = 302; response.setHeader('Location', exports[pathname]); response.end(); return; }
      if (pathname === '/docs/superpowers/references/admin-ui-approved/preview.html') { response.setHeader('Content-Type', 'text/html'); response.end(fs.readFileSync(path.join(root, pathname))); return; }
      next();
    });
  } }] });
  const receipt = { entry, entrySHA256, input, exports, startedAt, readyAt: Date.now(), bundle, port: server.httpServer.address().port, method: 'compiled existing fixture via Vite build/preview; optional strict exports share real frontend module state', fixtureTarget: 'esnext', envDir: false, emptyOutDir: false, realEvidenceContainment: true, ...(middleware ? { middlewarePlugin: middleware.name, hookSourceSHA256: crypto.createHash('sha256').update(middleware.configureServer.toString()).digest('hex'), sameMiddlewareClosure: true, vueFixtureDevtools: options.vueFixtureDevtools === true, apiRouteMocksAdded: false } : {}) };
  const receiptPath = path.join(bundle, 'build-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  if (middleware) fs.writeFileSync(path.join(realOut, 'actual-d1-transport.json'), JSON.stringify(receipt, null, 2));
  return {
    httpServer: server.httpServer,
    listen: async () => {},
    close: async () => {
      server.httpServer.closeAllConnections();
      await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
      fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, closedAt: Date.now(), connectionsClosed: true }, null, 2));
      if (middleware) fs.writeFileSync(path.join(realOut, 'actual-d1-transport.json'), JSON.stringify({ ...receipt, closedAt: Date.now(), connectionsClosed: true }, null, 2));
    }
  };
}

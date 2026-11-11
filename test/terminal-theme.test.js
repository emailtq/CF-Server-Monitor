import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { serveFrontend } from '../src/handlers/frontend.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';

const themeUrl = 'https://github.com/test/theme/tree/main';
const builtinHtml = '<!doctype html><html><head><title>Old</title><meta name="apiBase" content=""><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body><div id="builtin-admin"></div><script src="/bundled-admin.js"></script></body></html>';
const settings = {
  site_title: '<Trusted title>', favicon: '/favicon.png', theme_url: themeUrl,
  jwt_secret: 's'.repeat(64), terminal_enabled: 'true',
  custom_head: '<script>window.hostileHead = true</script><meta name="public-custom-head">',
  custom_script: 'window.hostileScript = true; </script><script src="https://hostile.invalid/payload.js">',
  custom_bg: '', custom_bg_mobile: '', csp_static: '', csp_api: ''
};

test('protected admin and terminal HTML ignores themes, preview authentication and public custom scripts', async () => {
  const originalFetch = globalThis.fetch;
  let themeFetches = 0;
  globalThis.fetch = async () => { themeFetches++; return new Response('<div id="public-theme"></div>'); };
  try {
    const env = {API_BASE:'https://example.com', ASSETS:{fetch:async () => new Response(builtinHtml)}};
    for (const path of ['/admin', '/admin/', '/admin#/admin/terminal/node-a', `/admin?theme_url=${encodeURIComponent(themeUrl)}#/admin/terminal/node-a`, '/admin/?theme_url=not-a-theme']) {
      const response = await serveFrontend(new Request(`https://example.com${path}`, {headers:{Cookie:`cfsm_theme_preview=${encodeURIComponent(themeUrl)}`}}), env, settings);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, /id="builtin-admin"/);
      assert.match(html, /src="\/bundled-admin.js"/);
      assert.doesNotMatch(html, /public-theme|hostileHead|hostileScript|public-custom-head|hostile\.invalid/);
      assert.match(html, /<title>&lt;Trusted title&gt;<\/title>/);
      assert.match(html, /rel="icon" href="\/favicon.png"/);
      assert.match(html, /name="apiBase" content="https:\/\/example.com"/);
      assert.match(html, /challenges\.cloudflare\.com\/turnstile/);
      assert.match(response.headers.get('Set-Cookie') || '', /cfsm_theme_preview=; Max-Age=0/);
    }
    assert.equal(themeFetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('public installed theme retains custom appearance, assets and authenticated previews while terminal is enabled', async () => {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async url => {
    fetched.push(String(url));
    return new Response(String(url).endsWith('/index.html') ? '<html><head></head><body><div id="public-theme"></div><script src="./assets/theme.js"></script></body></html>' : 'window.publicThemeAsset = true;');
  };
  try {
    const env = {};
    const token = await generateToken(env, settings);
    const cookie = `cfsm_theme_preview_auth=${encodeURIComponent(token)}`;
    const previewPath = `/?theme_url=${encodeURIComponent(themeUrl)}`;
    const assetPath = `/assets/theme.js?theme_url=${encodeURIComponent(themeUrl)}`;
    for (const path of [previewPath, assetPath]) {
      const denied = await serveFrontend(new Request(`https://example.com${path}`), env, settings);
      assert.equal(denied.status, 401);
    }
    assert.equal(fetched.length, 0, 'unauthenticated preview must not fetch theme resources');
    for (const path of ['/', previewPath]) {
      const response = await serveFrontend(new Request(`https://example.com${path}`, {headers:{Cookie:cookie}}), env, settings);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /id="public-theme"/);
      assert.match(html, /public-custom-head/);
      assert.match(html, /hostileHead/);
      assert.match(html, /hostileScript/);
      assert.match(html, /src="\/assets\/theme.js"/);
      if (path === previewPath) assert.match(response.headers.get('Set-Cookie') || '', /cfsm_theme_preview=/);
    }
    for (const path of ['/assets/theme.js', assetPath]) {
      const response = await serveFrontend(new Request(`https://example.com${path}`, {headers:{Cookie:cookie}}), env, settings);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'window.publicThemeAsset = true;');
    }
    const request = new Request('https://example.com/admin/api', {method:'POST', headers:{Authorization:`Bearer ${token}`}, body:JSON.stringify({action:'start_theme_preview', theme_url:themeUrl})});
    const preview = await handleAdminAPI(request, env, settings);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('Set-Cookie') || '', /cfsm_theme_preview_auth=/);
    assert.equal(new URL((await preview.json()).preview_url).searchParams.get('theme_url'), themeUrl);
    assert.ok(fetched.every(url => url.startsWith('https://raw.githubusercontent.com/test/theme/main/')));
  } finally { globalThis.fetch = originalFetch; }
});

test('terminal client helper permits protected admin preview queries but rejects actual public previews and cross-origin APIs', async () => {
  const vite = await createServer({configFile:false, appType:'custom', logLevel:'silent', server:{middlewareMode:true}});
  const originalWindow = globalThis.window;
  try {
    globalThis.window = {location:{origin:'https://example.com', pathname:'/admin', search:`?theme_url=${encodeURIComponent(themeUrl)}`}, __APP_API_BASES__:['https://example.com']};
    const { getTerminalBase } = await vite.ssrLoadModule('/src/frontend/utils/api.js');
    for (const pathname of ['/admin', '/admin/']) {
      window.location.pathname = pathname;
      assert.equal(getTerminalBase(), 'https://example.com');
    }
    for (const pathname of ['/', '/theme-preview', '/admin-lookalike']) {
      window.location.pathname = pathname;
      assert.throws(() => getTerminalBase(), /terminal_custom_frontend/);
    }
    window.location.pathname = '/admin';
    window.__APP_API_BASES__ = ['https://other.invalid'];
    assert.throws(() => getTerminalBase(), /terminal_origin_denied/);
    window.__APP_API_BASES__ = ['http://example.com'];
    assert.throws(() => getTerminalBase(), /terminal_origin_denied/);
  } finally { globalThis.window = originalWindow; await vite.close(); }
});

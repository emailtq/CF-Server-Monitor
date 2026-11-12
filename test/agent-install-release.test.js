import test from 'node:test';
import assert from 'node:assert/strict';

import { checkAgentInstallRelease } from '../src/frontend/utils/agentInstallRelease.js';
import { checkAgentImage } from '../src/utils/agentImage.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
const repo = 'https://api.github.com/repos/emailtq/cfsm-agent';
const asset = name => ({name, state:'uploaded', browser_download_url:`https://github.com/emailtq/cfsm-agent/releases/download/v9.0/${name}`});
const release = {tag_name:'v9.0', draft:false, assets:[asset('cf-probe-linux-amd64'), asset('cf-probe-windows-amd64.exe'), asset('cf-probe-darwin-arm64')]};
function transport(data = release, source = 'fs.StringVar(&terminal, "terminal", "", "")\nfs.StringVar(&token, "token-file", "", "")\nfs.StringVar(&key, "register-key", "", "")') {
  const calls = [];
  const request = async (url, options) => {
    calls.push([url, options]);
    if (url.includes('/releases/')) return data ? Response.json(data) : new Response('', {status:404});
    return Response.json({encoding:'base64',content:Buffer.from(url.includes('terminal_control.go') ? 'func (a *Agent) startTerminal(ctx context.Context) {}' : source).toString('base64')});
  };
  return {calls, request};
}
test('latest and pinned releases verify actual native assets and same-tag terminal CLI', async () => {
  for (const version of ['', 'latest', 'v9.0']) {
    const t = transport();
    const result = await checkAgentInstallRelease('linux',version, undefined,t.request);
    assert.equal(result.available,true);
    assert.equal(result.terminal,true);
    assert.equal(result.version,'v9.0');
    assert.equal(t.calls[0][0],`${repo}/releases/${!version || version === 'latest' ? 'latest' : 'tags/v9.0'}`);
    assert.ok(t.calls.slice(1).every(([url])=>url.includes('ref=v9.0')));
    assert.ok(t.calls.every(([,opts])=>opts.credentials === 'omit'));
  }
});
test('old CLI fails closed for monitoring too; token-capable other native platforms keep terminal off', async () => {
  const old = transport(release,'// historical CLI');
  assert.deepEqual(await checkAgentInstallRelease('linux','v9.0',undefined,old.request),{available:false,terminal:false,version:''});
  for (const os of ['windows','mac','unix']) {
    const t = transport();
    assert.equal((await checkAgentInstallRelease(os,'v9.0',undefined,t.request)).available,true);
    assert.equal((await checkAgentInstallRelease(os,'v9.0',undefined,t.request)).terminal,false);
  }
});
test('missing, draft, mismatched or absent platform assets never produce available downloads', async () => {
  for (const data of [null,{...release,draft:true},{...release,tag_name:'v8.0'},{...release,assets:[]},{...release,assets:[asset('cf-probe-darwin-amd64')]}]) {
    assert.equal((await checkAgentInstallRelease('linux','v9.0',undefined,transport(data).request)).available,false);
  }
});
test('source query failure cannot claim node-token monitoring support from assets alone', async () => {
  const result = await checkAgentInstallRelease('linux','v9.0',undefined,async url=>url.includes('/releases/') ? Response.json(release) : new Response('',{status:404}));
  assert.equal(result.available,false);
  assert.equal(result.terminal,false);
});
test('CLI flags without the same-tag terminal implementation cannot claim terminal support', async () => {
  const t=transport();
  const result=await checkAgentInstallRelease('linux','v9.0',undefined,(url,opts)=>url.includes('terminal_control.go') ? new Response('',{status:404}) : t.request(url,opts));
  assert.equal(result.available,true);
  assert.equal(result.terminal,false);
});
test('Docker verifies the actual public registry manifest rather than guessing from a release', async () => {
  const calls=[];
  const result=await checkAgentImage('9.0',async (url,opts)=>{calls.push([url,opts]);return url.includes('/token?') ? Response.json({token:'public-registry-read-only'}) : Response.json({schemaVersion:2,manifests:[{}]});});
  assert.equal(result.available,true);
  assert.ok(calls.some(([url])=>url.includes('/manifests/9.0')));
  assert.ok(calls.every(([url])=>url.startsWith('https://ghcr.io/')));
  assert.equal(JSON.stringify(result).includes('public-registry-read-only'),false);
});
test('registry lookup rejects path injection before fetch and fails closed on invalid manifests', async () => {
  let calls=0;
  assert.equal((await checkAgentImage('../other',async()=>{calls++;throw new Error();})).available,false);
  assert.equal(calls,0);
  assert.equal((await checkAgentImage('latest',async url=>Response.json(url.includes('/token?') ? {token:'synthetic'} : {schemaVersion:2}))).available,false);
});
test('Docker never falls back to browser registry fetch without an authenticated verifier', async () => {
  let calls=0;
  const result=await checkAgentInstallRelease('docker','latest',undefined,async()=>{calls++;throw new Error();});
  assert.equal(result.available,false);
  assert.equal(calls,0);
});

test('Docker manifest presence is not evidence of the node-token protocol', async () => {
  const t=transport();
  const result=await checkAgentInstallRelease('docker','v9.0',undefined,t.request,async()=>({available:true}));
  assert.equal(result.available,false);
});

test('every platform rejects a CLI missing either token-file or register-key', async () => {
  for (const os of ['linux','unix','mac','windows']) {
    for (const source of ['fs.StringVar(&token,"token-file","","")','fs.StringVar(&key,"register-key","","")']) {
      assert.equal((await checkAgentInstallRelease(os,'v9.0',undefined,transport(release,source).request)).available,false);
    }
  }
});

test('image lookup passes the actual authenticated admin boundary and returns availability only', async () => {
  const secret='synthetic-image-admin-secret-at-least-32-bytes';
  const token=await generateToken({}, {jwt_secret:secret});
  const saved=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async url=>{calls.push(url);return Response.json(url.includes('/token?') ? {token:'never-return-registry-token'} : {schemaVersion:2,config:{digest:'sha256:synthetic'}});};
  try {
    const call=cookie=>handleAdminAPI(new Request('https://monitor.invalid/admin/api',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({action:'agent_install_image',tag:'fixture-boundary'})}),{}, {jwt_secret:secret});
    assert.equal((await call('')).status,401);
    assert.equal(calls.length,0);
    const response=await call(`cfsm_auth=${encodeURIComponent(token)}`);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{available:true});
    assert.equal(calls.length,2);
  } finally { globalThis.fetch=saved; }
});

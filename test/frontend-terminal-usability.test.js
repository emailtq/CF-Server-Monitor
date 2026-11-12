import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { once, getEventListeners } from 'node:events';

test('compiled admin terminal entry, cancellable observation refresh and minimal download actions', {timeout:120000}, () => {
  const result = spawnSync(process.execPath, ['test/fixtures/admin-ui/terminal-usability.mjs'], {
    encoding:'utf8', windowsHide:true, timeout:120000, env:process.env
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

test('terminal transport composes cancellation with timeout and cleans timers; legacy fake controller still works', async () => {
  const vite = await createServer({configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true}});
  const keys=['window','document','localStorage','fetch','setTimeout','clearTimeout','AbortController'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  try {
    const api=await vite.ssrLoadModule('/src/frontend/utils/api.js');
    globalThis.window=Object.assign(new EventTarget(),{location:{origin:'https://fixture.test',pathname:'/admin'}});
    globalThis.document={querySelector:()=>null}; globalThis.localStorage={getItem:()=>null};
    const timers=new Map(); let next=0, received;
    globalThis.setTimeout=(fn,ms)=>{ const id=++next; timers.set(id,{fn,ms}); return id; };
    globalThis.clearTimeout=id=>timers.delete(id);
    globalThis.fetch=(_url,init)=>new Promise((_resolve,reject)=>{
      received=init.signal;
      init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
    });
    const caller=new saved.AbortController();
    let owner=true;
    const cancelled=api.adminApi({action:'terminal_status',serverId:'node-a'},0,()=>owner,caller.signal);
    assert.notEqual(received,caller.signal); assert.equal(timers.size,1);
    owner=false; caller.abort(); assert.equal((await cancelled).stale,true);
    assert.equal(received.aborted,true); assert.equal(timers.size,0);
    const external=new saved.AbortController();
    const timeout=api.adminApi({action:'terminal_status',serverId:'node-a'},0,undefined,external.signal);
    assert.equal([...timers.values()][0].ms,15000);
    [...timers.values()][0].fn();
    assert.equal((await timeout).timeout,true); assert.equal(received.aborted,true);
    assert.equal(external.signal.aborted,false); assert.equal(timers.size,0);
    globalThis.fetch=async()=>Response.json({enabled:false,state:'pending'});
    for(let i=0;i<20;i++) assert.equal((await api.adminApi({action:'terminal_status',serverId:'node-a'},0,undefined,external.signal)).data.state,'pending');
    assert.equal(timers.size,0);
    assert.equal(getEventListeners(external.signal,'abort').length,0,'composition must not leave explicit listeners on the caller');
    globalThis.AbortController=class {
      constructor(){this.signal=Object.assign(new EventTarget(),{aborted:false});}
      abort(){this.signal.aborted=true;this.signal.dispatchEvent(new Event('abort'));}
    };
    globalThis.fetch=(_url,init)=>new Promise((_resolve,reject)=>{
      received=init.signal; init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
    });
    const legacy=api.adminApi({action:'terminal_status',serverId:'node-a'});
    [...timers.values()][0].fn(); assert.equal((await legacy).timeout,true);
    assert.equal(received.aborted,true); assert.equal(timers.size,0);
  } finally { Object.assign(globalThis,saved); await vite.close(); }
});

test('HTTP adapter cancellation and timeout actually close a pending native transport', async () => {
  const vite=await createServer({configFile:false,appType:'custom',logLevel:'silent',server:{middlewareMode:true}});
  const server=createHttpServer();
  const saved={window:globalThis.window,localStorage:globalThis.localStorage};
  try {
    const {http}=await vite.ssrLoadModule('/src/frontend/utils/http.js');
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    globalThis.window={location:{origin:baseUrl,pathname:'/admin'}};
    globalThis.localStorage={getItem:()=>null};
    for(const mode of ['caller','timeout']) {
      const controller=new AbortController();
      const incoming=once(server,'request');
      const pending=http.post('/pending',{}, {baseUrl,includeAuth:false,autoRedirect:false,signal:controller.signal,timeoutMs:mode==='caller'?2000:80});
      const [,response]=await incoming;
      const closed=once(response,'close');
      if(mode==='caller') controller.abort();
      const result=await pending;
      assert.equal(result.timeout,true);
      await closed; assert.equal(response.destroyed,true);
      assert.equal(controller.signal.aborted,mode==='caller');
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
    }
  } finally {
    Object.assign(globalThis,saved); server.closeAllConnections();
    if(server.listening) await new Promise(resolve=>server.close(resolve));
    await vite.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname, basename } from 'node:path';
import https from 'node:https';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createMonitorRuntimeFixture } from './fixtures/monitor-runtime.mjs';
import { readMonitorTelemetry } from '../src/database/monitorTelemetry.js';
import { prepareMonitorReporting } from '../src/services/monitorReporting.js';
import { parseMonitorBatch } from '../src/shared/monitorTelemetry.js';
import { monitorReceiptText } from '../src/shared/monitorTelemetry.js';
import { changeLatencyTasks } from '../src/database/latencyTasks.js';
import { readMonitorRecoverySnapshot, assertOriginalMonitorFacts } from './helpers/monitorRecovery.js';

const agent = resolve(process.env.CFSM_MONITOR_AGENT_ROOT || '../cfsm-agent');
const go = resolve(process.env.CFSM_MONITOR_GO || '.planning/2026-11-05-agent-terminal-proposal/tools/go/bin/go.exe');
const env = { ...process.env, GOMAXPROCS: '2', GOFLAGS: '-p=1' };
function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: agent, env, windowsHide: true, ...options });
  let output = '';
  child.stdout.on('data', data => output += data);child.stderr.on('data', data => output += data);
  const done = new Promise((resolve, reject) => {child.on('error', reject);child.on('close', code => resolve({code,output}));});
  return {child, done};
}
async function waitFor(predicate, description) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,100)); }
  throw new Error(`Timed out: ${description}`);
}

test('actual Go Execute/manual and Run/config → TLS Bearer101 → current Worker index/global DO/native collector/real TCP tasks',
  {timeout:300000, skip:!existsSync(go)||!existsSync(agent) ? 'requires adjacent Agent and Go1.27.3 toolchain; set CFSM_MONITOR_GO/AGENT_ROOT' : false}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'cfsm-monitor-go-'));
  const stateName=`.cfsm-s3-monitor-${process.pid}-${randomUUID()}`;
  const stateParent=join(homedir(),stateName);
  const evidence = process.env.CFSM_MONITOR_GO_EVIDENCE;
  const save = async (name,data) => {if(evidence) await writeFile(join(evidence,name),data);};
  t.after(async()=>{const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+'/')||target.startsWith(resolve(tmpdir())+'\\'));await rm(target,{recursive:true,force:true});});
  t.after(async()=>{const target=resolve(stateParent);assert.equal(dirname(target),resolve(homedir()));assert.equal(basename(target),stateName);await rm(target,{recursive:true,force:true});});
  const binary=join(dir,process.platform==='win32'?'monitor.test.exe':'monitor.test');
  const build=await run(go,['test','-p','1','-c','-o',binary,'./internal/cfprobe']).done;
  await save('S2-GoAgent-build.log',build.output);assert.equal(build.code,0,build.output);
  const material=await run(binary,['-test.run=^TestMonitorWorkerTLSMaterial$','-test.v'],{env:{...env,CFSM_MONITOR_TLS_DIR:dir,CFSM_MONITOR_STATE_PARENT:stateParent}}).done;
  assert.equal(material.code,0,material.output);
  const cert=await readFile(join(dir,'root.pem')),key=await readFile(join(dir,'key.pem'));
  const listener=net.createServer(socket=>socket.destroy());await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  t.after(()=>listener.close());
  const refused=net.createServer();await new Promise(r=>refused.listen(0,'127.0.0.1',r));const refusedPort=refused.address().port;await new Promise(r=>refused.close(r));
  for(const kind of ['manual','run','standard']) {
    if(process.env.CFSM_MONITOR_GO_KINDS && !process.env.CFSM_MONITOR_GO_KINDS.split(',').includes(kind)) continue;
    const persistencePath=join(dir,'d1-'+kind);
    let h=await createMonitorRuntimeFixture(null,{persistencePath});
    await h.db.prepare("UPDATE servers SET report_interval=30 WHERE id='node-a'").run();
    if(kind!=='standard') await h.db.batch([prepareMonitorReporting(h.db,'node-a',{collect_interval:2,report_interval:30,wss_report_interval:2,reset_day:1,connection_mode:'auto'},'')]);
    for(const [name,port] of [['actual success',listener.address().port],['actual refused timeout sentinel',refusedPort]]) await changeLatencyTasks(h.db,{},'save',{name,target:`127.0.0.1:${port}`,interval:5,auto_join:false,nodes:['node-a']});
    const inbound=[],outbound=[],requests=[],upstreams=[],clients=[],http=[];
    let dropACK=kind==='manual',httpFail=kind==='manual',blockUpgrade=false;
    const relay=https.createServer({cert,key},async(req,res)=>{
      requests.push(req.url);
      if(req.url!=='/api/agent/cf-report'){res.writeHead(404);res.end();return;}
      const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString();
      const fail=httpFail;httpFail=false;
      if(fail) await h.control('fault',{telemetryRead:true});
      try {
        await h.control('drain',{serverId:'node-a'});
        const traceWindow={from:Date.now()-300000,to:Date.now()+1};
        const beforeReplay=await readMonitorRecoverySnapshot(h.db,'node-a',traceWindow);
        const response=await h.fetch(req.url,{method:'POST',headers:{Authorization:req.headers.authorization,'Content-Type':'application/json'},body:raw});
        const body=await response.text();
        const afterReplay=await readMonitorRecoverySnapshot(h.db,'node-a',traceWindow);
        assert.deepEqual(afterReplay,beforeReplay,'replay or failed receipt read must not change any D1 metric fact');
        http.push({raw,status:response.status,body,beforeReplay,afterReplay,fault:fail?'D1 receipt read unavailable':null});res.writeHead(response.status,{'Content-Type':'application/json'});res.end(body);
      }catch(e){http.push({raw,status:503,error:e.stack || String(e)});res.writeHead(503);res.end();}
      finally {if(fail) await h.control('fault',{telemetryRead:false});}
    });
    const wsServer=new WebSocketServer({noServer:true});
    relay.on('upgrade',(req,socket,head)=>{
      requests.push(req.url);
      if(blockUpgrade){socket.end('HTTP/1.1 503 Test outage\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
      h.mf.ready.then(runtime=>{
        const target=new URL(req.url,runtime);target.protocol='ws:';
        const headers={'MF-Original-URL':`https://example.com${req.url}`};
        for(const name of ['authorization','user-agent','accept','x-agent-version','x-agent-config-schema','x-agent-config-md5'])if(req.headers[name])headers[name]=req.headers[name];
        const upstream=new WebSocket(target,{headers});upstreams.push(upstream);
        upstream.on('error',()=>socket.destroy());
        upstream.on('unexpected-response',(_r,response)=>{socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);response.resume();});
        upstream.on('open',()=>wsServer.handleUpgrade(req,socket,head,client=>{
          clients.push(client);
          client.on('message',(raw,binary)=>{
            if(!binary)inbound.push(raw.toString());
            if(kind==='standard'&&!binary){const f=JSON.parse(raw);if(f.method==='cf.capabilities'){f.params.supports=[];raw=Buffer.from(JSON.stringify(f));}}
            upstream.send(raw,{binary});
          });
          upstream.on('message',(raw,binary)=>{
            if(!binary)outbound.push(raw.toString());
            if(dropACK&&!binary&&JSON.parse(raw).result?.durableThrough){dropACK=false;blockUpgrade=true;client.terminate();upstream.terminate();return;}
            client.send(raw,{binary});
          });
          client.on('close',()=>upstream.close());upstream.on('close',()=>client.close());client.on('error',()=>upstream.terminate());
        }));
      }).catch(()=>socket.destroy());
    });
    await new Promise(r=>relay.listen(0,'127.0.0.1',r));
    const stop=join(dir,`stop-${kind}`),state=join(stateParent,kind);
    const startChild=()=>run(binary,['-test.run=^TestMonitorWorkerEntryPoint$','-test.v'],{env:{...env,GODEBUG:'x509usefallbackroots=1',CFSM_REPORT_TEST_ROOT:join(dir,'root.pem'),CFSM_MONITOR_WORKER_URL:`https://127.0.0.1:${relay.address().port}`,CFSM_MONITOR_WORKER_TOKEN:h.nodes['node-a'].token,CFSM_MONITOR_RUN_KIND:kind==='run'?'run':'manual',CFSM_MONITOR_WORKER_STATE:state,CFSM_MONITOR_STOP:stop}});
    let child=startChild();
    const queue=async()=>JSON.parse(await readFile(join(state,'monitor-queue.json'),'utf8')).Scopes.map(({Scope,...s})=>({...s,origin:Scope.Origin,node:Scope.Node}));
    let recovery=null;
    try {
      if(kind==='manual') {
        await waitFor(()=>http.some(r=>r.status===500),'lost WS ACK → actual HTTP500');
        const retained=await queue();assert.equal(retained[0].Through,0);assert.equal(retained[0].Batches.length,1);
        child.child.kill();const crashed=await child.done;await save('S2-GoAgent-manual-before-restart.log',crashed.output);
        await h.control('drain',{serverId:'node-a'});
        const original=await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-300000,to:Date.now()+1});
        const timestamps=[...original.rawSamples.map(s=>s.sampledAt),...original.probeSeries.flatMap(p=>p.samples.map(s=>s.sampledAt))];
        const fixedWindow={from:Math.min(...timestamps)-1,to:Math.max(...timestamps)+1};
        const beforeSnapshot=await readMonitorRecoverySnapshot(h.db,'node-a',fixedWindow),before=beforeSnapshot.core;
        const receiptsBefore=beforeSnapshot.receipts;
        assert.equal(Buffer.from(retained[0].Batches[0].Params,'base64').toString(),await monitorReceiptText(receiptsBefore[0].params));
        const nodes=h.nodes;await h.dispose();h=await createMonitorRuntimeFixture(null,{persistencePath,seed:false,nodes});
        const afterSnapshot=await readMonitorRecoverySnapshot(h.db,'node-a',fixedWindow),after=afterSnapshot.core;assert.deepEqual(afterSnapshot,beforeSnapshot);
        dropACK=true;blockUpgrade=false;child=startChild();
        await waitFor(()=>http.some(r=>r.status===200),'sameDB reconstructed DO → HTTP durable replay');
        await waitFor(async()=> (await queue())[0].Through===1,'matching HTTP ACK clears actual private queue');
        const cleared=await queue();assert.ok(cleared[0].Batches.every(b=>b.Sequence>cleared[0].Through));assert.equal(cleared[0].Stream,retained[0].Stream);
        await h.control('drain',{serverId:'node-a'});
        const replayedSnapshot=await readMonitorRecoverySnapshot(h.db,'node-a',fixedWindow),replayed=replayedSnapshot.core;
        assertOriginalMonitorFacts(beforeSnapshot,replayedSnapshot);
        const receiptsAfter=replayedSnapshot.receipts;assert.deepEqual(receiptsAfter,receiptsBefore);
        for(const entry of http) assert.equal(parseMonitorBatch(entry.raw).paramsRaw,await monitorReceiptText(receiptsBefore[0].params));
        const expanded=await readMonitorTelemetry(h.db,'node-a',{from:fixedWindow.from,to:Date.now()+1});
        const freshInputs={since:fixedWindow.to,factsBefore:before.facts,factsAfter:replayed.facts,clockBefore:before.clock,clockAfter:replayed.clock,
          sourceBefore:before.source,sourceAfter:replayed.source,
          probes:expanded.probeSeries.flatMap(p=>p.samples).filter(p=>p.sampledAt>=fixedWindow.to),samples:expanded.rawSamples.filter(s=>s.sampledAt>=fixedWindow.to)};
        await h.dispose();h=await createMonitorRuntimeFixture(null,{persistencePath,seed:false,nodes});
        const acknowledgedSnapshot=await readMonitorRecoverySnapshot(h.db,'node-a',fixedWindow),acknowledgedReopen=acknowledgedSnapshot.core;assert.deepEqual(acknowledgedSnapshot,replayedSnapshot);
        const originalRpc=http.find(r=>r.status===200).raw;
        const acknowledgedReplay=await h.fetch('/api/agent/cf-report',{method:'POST',headers:{Authorization:`Bearer ${nodes['node-a'].token}`,'Content-Type':'application/json'},body:originalRpc});
        assert.equal(acknowledgedReplay.status,200);
        assert.deepEqual(await readMonitorRecoverySnapshot(h.db,'node-a',fixedWindow),acknowledgedSnapshot);
        recovery={retained,cleared,fixedWindow,before,after,replayed,beforeSnapshot,afterSnapshot,replayedSnapshot,freshInputs,receiptsBefore,receiptsAfter,
          agentProcessRestarted:true,acknowledgedReopen,acknowledgedSnapshot,acknowledgedReplay:await acknowledgedReplay.json()};
        t.diagnostic(JSON.stringify({originalWindow:fixedWindow,originalSamples:before.coverage.sampleCount,originalProbes:before.coverage.probeCount,
          freshProbes:freshInputs.probes.length,freshSamples:freshInputs.samples.length,factGeneration:[before.facts?.generation,replayed.facts?.generation],replayChangedD1:false}));
        blockUpgrade=false;
      }
      if(kind==='standard') {
        await waitFor(async()=>{const core=await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-300000,to:Date.now()+300000});return core.coverage.sampleCount>=2&&core.probeSeries.some(p=>p.timeouts>0)&&core.probeSeries.some(p=>p.mean>=0);},'real standard-only receiptless D1');
      }else {
        const expected=kind==='manual'?2:1;
        await waitFor(async()=> (await h.db.prepare("SELECT COUNT(*) n FROM monitor_telemetry_receipts WHERE server_id='node-a'").first()).n>=expected,'real CF batch D1');
        await waitFor(async()=> (await queue())[0].Through>=expected,'WS ACK clears private queue after reconnect');
      }
      const snapshot=await h.snapshot(),core=await readMonitorTelemetry(h.db,'node-a',{from:Date.now()-300000,to:Date.now()+300000});
      const frames=inbound.map(r=>JSON.parse(r)),replies=outbound.map(r=>JSON.parse(r)),caps=replies.find(r=>r.result?.accepted).result;
      assert.deepEqual(frames.slice(0,2).map(f=>f.method),['hello','report']);
      assert.ok(frames.filter(f=>f.method==='report').length>=(kind==='standard'?2:1));
      const first=frames.find(f=>f.method==='report');assert.equal(typeof first.params.net_rx_total,'number');
      assert.ok(core.probeSeries.some(p=>p.mean>=0));assert.ok(core.probeSeries.some(p=>p.timeouts>0));
      const q=await queue(),receipts=(await h.db.prepare('SELECT stream,sequence,params,ack,parts FROM monitor_telemetry_receipts ORDER BY sequence').all()).results;
      if(kind==='standard'){assert.deepEqual(caps.accepted,[]);assert.equal(caps.fallbackPath,null);assert.equal(receipts.length,0);assert.equal(core.source,'standard');}
      else {
        assert.deepEqual(caps.accepted.map(c=>c.method),['cf.report.batch','cf.reporting.configure','cf.ping.tasks']);assert.equal(caps.fallbackPath,'/api/agent/cf-report');
        const originalParams=await Promise.all(receipts.map(r=>monitorReceiptText(r.params)));
        const samples=originalParams.flatMap(r=>JSON.parse(r).samples),probes=originalParams.flatMap(r=>JSON.parse(r).probes);
        const transitionProbes=core.probeSeries.flatMap(p=>p.samples).filter(p=>p.source==='standard').length;
        assert.equal(core.coverage.sampleCount,samples.length);assert.equal(core.coverage.probeCount,probes.length+transitionProbes);assert.equal(core.coverage.elapsedMs,samples.reduce((n,s)=>n+s.elapsedMs,0));
        assert.equal(core.traffic.totalRx,String(BigInt(JSON.parse(originalParams.at(-1)).samples.at(-1).report.net_rx_total)-BigInt(JSON.parse(originalParams[0]).samples[0].report.net_rx_total)));
        assert.equal(core.traffic.totalTx,String(BigInt(JSON.parse(originalParams.at(-1)).samples.at(-1).report.net_tx_total)-BigInt(JSON.parse(originalParams[0]).samples[0].report.net_tx_total)));
        assert.ok(frames.some(r=>r.result?.persisted&&r.result?.revision));assert.equal(q[0].Batches.length,0);
      }
      assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM metrics_history').first()).n,0);
      const record={kind,route:'real Execute/Run → test TLS relay → current Worker/index/globalDO/MonitorAgentSession → atomic D1 → durable ACK → private queue',requests,inbound,outbound,http,core,receipts,queue:q,recovery,hostObserved:first.params,timeoutSource:'actual closed loopback TCP port; real prober returns protocol timeout sentinel -1',snapshot};
      assert.ok(!JSON.stringify(record).includes(h.nodes['node-a'].token));await save(`S2-GoAgent-${kind}.json`,JSON.stringify(record,null,2));
      t.diagnostic(JSON.stringify({kind,batches:receipts.length,samples:core.coverage.sampleCount,elapsedMs:core.coverage.elapsedMs,probes:core.coverage.probeCount,rx:core.traffic?.totalRx,tx:core.traffic?.totalTx,loss:core.probeSeries.map(p=>p.loss),through:q[0].Through,recovery:!!recovery}));
      await writeFile(stop,'observed');const result=await child.done;await save(`S2-GoAgent-${kind}.log`,result.output);assert.equal(result.code,0,result.output);
    } finally {
      await save(`S2-GoAgent-${kind}-network.json`,JSON.stringify({requests,inbound,outbound,http,queue:await queue().catch(()=>null)},null,2));
      if(child.child.exitCode===null){child.child.kill();await child.done;}
      for(const ws of [...clients,...upstreams])ws.terminate();await new Promise(r=>relay.close(r));wsServer.close();await h.dispose();
    }
  }
});

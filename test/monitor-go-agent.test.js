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
import { changeLatencyTasks } from '../src/database/latencyTasks.js';

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
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,100)); }
  throw new Error(`Timed out: ${description}`);
}

test('actual Go Execute/manual and Run/config → TLS Bearer101 → current Worker index/global DO/native collector/real TCP tasks',
  {timeout:120000, skip:!existsSync(go)||!existsSync(agent) ? 'requires adjacent Agent and Go1.27.3 toolchain; set CFSM_MONITOR_GO/AGENT_ROOT' : false}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'cfsm-monitor-go-'));
  const stateName=`.cfsm-s3-monitor-${process.pid}-${randomUUID()}`;
  const stateParent=join(homedir(),stateName);
  const evidence = process.env.CFSM_MONITOR_GO_EVIDENCE;
  const save = async (name,data) => {if(evidence) await writeFile(join(evidence,name),data);};
  t.after(async()=>{const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+'/')||target.startsWith(resolve(tmpdir())+'\\'));await rm(target,{recursive:true,force:true});});
  t.after(async()=>{const target=resolve(stateParent);assert.equal(dirname(target),resolve(homedir()));assert.equal(basename(target),stateName);await rm(target,{recursive:true,force:true});});
  const binary=join(dir,process.platform==='win32'?'monitor.test.exe':'monitor.test');
  const build=await run(go,['test','-p','1','-c','-o',binary,'./internal/cfprobe']).done;
  await save('S3-GoAgent-build.log',build.output);assert.equal(build.code,0,build.output);
  const material=await run(binary,['-test.run=^TestMonitorWorkerTLSMaterial$','-test.v'],{env:{...env,CFSM_MONITOR_TLS_DIR:dir,CFSM_MONITOR_STATE_PARENT:stateParent}}).done;
  assert.equal(material.code,0,material.output);
  const cert=await readFile(join(dir,'root.pem')),key=await readFile(join(dir,'key.pem'));
  const listener=net.createServer(socket=>socket.destroy());await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  t.after(()=>listener.close());
  for(const kind of ['manual','run']) {
    const h=await createMonitorRuntimeFixture(null);
    const task=await changeLatencyTasks(h.db,{},'save',{name:'actual TCP',target:`127.0.0.1:${listener.address().port}`,interval:5,auto_join:false,nodes:['node-a']});
    const inbound=[],outbound=[],requests=[],upstreams=[],clients=[];
    const relay=https.createServer({cert,key},(req,res)=>{requests.push(req.url);res.writeHead(404);res.end();});
    const wsServer=new WebSocketServer({noServer:true});
    relay.on('upgrade',(req,socket,head)=>{
      requests.push(req.url);
      // Relay is test-only TLS. The upstream handshake is still authenticated by the actual Worker.
      h.mf.ready.then(runtime=>{
        const target=new URL(req.url,runtime);target.protocol='ws:';
        const headers={'MF-Original-URL':`https://example.com${req.url}`};
        for(const name of ['authorization','user-agent','accept','x-agent-version','x-agent-config-schema','x-agent-config-md5']) {
          if(req.headers[name]) headers[name]=req.headers[name];
        }
        const upstream=new WebSocket(target,{headers});
        upstreams.push(upstream);
        upstream.on('error',()=>socket.destroy());
        upstream.on('unexpected-response',(_request,response)=>{socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);response.resume();});
        upstream.on('open',()=>wsServer.handleUpgrade(req,socket,head,client=>{
          clients.push(client);
          client.on('message',(raw,binary)=>{if(!binary)inbound.push(raw.toString());upstream.send(raw,{binary});});
          upstream.on('message',(raw,binary)=>{if(!binary)outbound.push(raw.toString());client.send(raw,{binary});});
          client.on('close',()=>upstream.close());upstream.on('close',()=>client.close());
          client.on('error',()=>upstream.terminate());
        }));
      }).catch(()=>socket.destroy());
    });
    await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
    const stop=join(dir,`stop-${kind}`);
    const child=run(binary,['-test.run=^TestMonitorWorkerEntryPoint$','-test.v'],{env:{...env,GODEBUG:'x509usefallbackroots=1',CFSM_REPORT_TEST_ROOT:join(dir,'root.pem'),CFSM_MONITOR_WORKER_URL:`https://127.0.0.1:${relay.address().port}`,CFSM_MONITOR_WORKER_TOKEN:h.nodes['node-a'].token,CFSM_MONITOR_RUN_KIND:kind,CFSM_MONITOR_WORKER_STATE:join(stateParent,kind),CFSM_MONITOR_STOP:stop}});
    try {
      await waitFor(async()=>{
        const input=(await h.snapshot()).inputs.find(([id])=>id==='node-a')?.[1];
        return input?.latest?.trafficReading && input?.facts?.os && input?.probes?.length>=2;
      },`real ${kind} collector/repeated tasks`);
      const snapshot=await h.snapshot(),input=snapshot.inputs.find(([id])=>id==='node-a')[1];
      const frames=inbound.map(raw=>JSON.parse(raw)),replies=outbound.map(raw=>JSON.parse(raw));
      const hello=frames.find(frame=>frame.method==='hello'),report=frames.find(frame=>frame.method==='report');
      assert.ok(hello&&report);assert.deepEqual(frames.slice(0,2).map(frame=>frame.method),['hello','report']);
      assert.ok(frames.filter(frame=>frame.method==='report').length>=2);
      assert.ok(!('id' in report)&&!('type' in report));
      assert.equal(typeof report.params.net_rx_total,'number');assert.ok(Number.isSafeInteger(report.params.mem_total));
      assert.ok(input.probes.every(probe=>probe.taskId===1&&probe.metricId===task.tasks[0].id&&BigInt(probe.latencyMs)>=0n));
      const caps=replies.find(frame=>frame.result?.accepted);assert.deepEqual(caps.result.accepted,[]);assert.equal(caps.result.fallbackPath,null);
      assert.ok(replies.some(frame=>frame.method==='ping.tasks'&&Array.isArray(frame.params)&&frame.params[0]?.id===1));
      assert.ok(!frames.some(frame=>frame.method==='cf.report.batch'||frame.method==='cf.ssh.events'||frame.method?.startsWith('cf.terminal.')||frame.type));
      assert.ok(!replies.some(frame=>frame.type==='ack'||frame.result?.durableThrough));
      assert.ok(requests.every(path=>path==='/api/agent/ws'));assert.equal(snapshot.attachments.some(a=>a.kind?.includes('terminal')),false);
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS count FROM metrics_history').first()).count,0);
      assert.equal(input.latest.report.net_rx_total,String(input.latest.trafficReading.rx));
      if(process.platform==='win32'){assert.equal('load' in report.params,false);assert.equal('swap_total' in report.params,false);}
      assert.ok(!JSON.stringify({frames,replies,snapshot}).includes(h.nodes['node-a'].token));
      const record={kind,route:'Go Execute/Run → test-only TLS relay → actual Worker index → global MetricsBroadcaster/MonitorAgentSession',status:101,
        reports:frames.filter(f=>f.method==='report').length,hello:hello.params,firstReport:report.params,latest:input.latest,probes:input.probes,capabilities:caps.result,
        unknown:process.platform==='win32'?['load','swap_total','swap_used']:[],durableACK:false,historyRows:0,requests};
      t.diagnostic(JSON.stringify(record));await save(`S3-GoAgent-${kind}.json`,JSON.stringify(record,null,2));
      await writeFile(stop,'observed');const result=await child.done;await save(`S3-GoAgent-${kind}.log`,result.output);assert.equal(result.code,0,result.output);
      assert.ok(!result.output.includes(h.nodes['node-a'].token));
    } finally {
      if(child.child.exitCode===null){child.child.kill();await child.done;}
      for(const ws of [...clients,...upstreams])ws.terminate();
      await new Promise(resolve=>relay.close(resolve));wsServer.close();await h.dispose();
    }
  }
});

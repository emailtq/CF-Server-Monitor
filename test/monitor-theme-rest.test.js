import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { writeFileSync } from 'node:fs';
import { generateToken } from '../src/middleware/auth.js';
import { saveSiteOptions } from '../src/utils/settings.js';
import { issueNodeToken } from '../src/database/nodeCredentials.js';

const origin = 'https://s2.example.test';
const secret = 's2-test-only-authority-'.repeat(3);
const bundle = build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:*']});
const meta = {name:'Audit',short:'audit',description:'Original package',version:'1',author:'fixture',url:'https://github.com/fixture/audit',config:[{key:'enabled',type:'boolean',default:true}],unknown:{nested:['kept']}};
const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
function entry(name, value) {
  const data = Buffer.from(value), header = Buffer.alloc(512);
  header.write(name); header.write('0000644\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
  header.write(data.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136);
  header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257);
  header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
  return Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512)]);
}
function archive(manifest=meta) {
  return gzipSync(Buffer.concat([entry('theme.json',JSON.stringify(manifest)),entry('preview.png',png),
    entry('dist/index.html','<html><head><link rel="icon" href="/favicon.svg"><script src="/static/audit.js"></script></head><body>audit</body></html>'),
    entry('dist/static/audit.js',`console.log("original ${manifest.version}")`),entry('dist/manifest.json','{"name":"original manifest"}'),
    entry('dist/favicon.svg','<svg>theme icon</svg>'),entry('dist/os-icons/test.svg','<svg>original OS</svg>'),Buffer.alloc(1024)]));
}
function evidence(name, data) { if(process.env.CFSM_S2_EVIDENCE)writeFileSync(`${process.env.CFSM_S2_EVIDENCE}/S2-${name}.json`,JSON.stringify(data,null,2)); }
async function fixture(t, {outboundService}={}) {
  const mf = new Miniflare({modules:true,script:(await bundle).outputFiles[0].text,compatibilityDate:'2024-12-01',compatibilityFlags:['nodejs_compat'],
    durableObjects:{METRICS_BROADCASTER:{className:'MetricsBroadcaster',useSQLite:true},TERMINAL_BROKER:{className:'TerminalBroker',useSQLite:true}},d1Databases:{DB:'s2-theme'},serviceBindings:{ASSETS:request=>new Response('CF '+new URL(request.url).pathname)},...(outboundService?{outboundService}:{})});
  t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB'); const {initDatabase}=await import('../src/database/schema.js?fixture='+crypto.randomUUID()); await initDatabase(db);
  await saveSiteOptions(db,{jwt_secret:secret,is_public:'true',auto_discovery:'true',custom_ct:'',custom_cu:'',custom_cm:'',custom_bd:'',node_1:'',node_2:'',node_3:'',node_4:''});
  const token=await generateToken({}, {jwt_secret:secret}),other=await generateToken({}, {jwt_secret:secret});
  const auth={Cookie:`cfsm_auth=${token}`,Origin:origin},otherAuth={Cookie:`cfsm_auth=${other}`,Origin:origin};
  const fetch=async(path,options={})=>{
    let response=await mf.dispatchFetch(origin+path,options);
    for(let n=0;response.status===307&&n<3;n++)response=await mf.dispatchFetch(response.headers.get('Location'),options);
    return response;
  };
  const json=(path,body,method='PUT',headers=auth)=>fetch(path,{method,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const upload=(bytes,offset=0,total=bytes.length,headers=auth)=>fetch(`/api/themes?offset=${offset}&total=${total}`,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes});
  const whole=async bytes=>{const r=await fetch('/admin/api/monitor-themes/upload',{method:'POST',headers:auth,body:bytes});assert.equal(r.status,200);return (await r.json()).theme;};
  return {db,mf,token,other,auth,otherAuth,fetch,json,upload,whole};
}

test('native REST list/settings/config/PNG/delete consume the existing theme business',async t=>{
  const h=await fixture(t); const theme=await h.whole(archive());
  const response=await h.fetch('/api/themes',{headers:h.auth});assert.equal(response.status,200);
  const list=await response.json(),audit=list.themes.find(x=>x.short==='audit');assert.equal(audit.selected,false);assert.equal(audit.builtin,false);assert.equal(audit.preview,true);assert.deepEqual(audit.unknown,meta.unknown);
  assert.equal((await h.json('/api/settings',{theme:'audit',site_name:'A site',public_page:'on'})).status,200);
  const selected=(await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(x=>x.short==='audit');assert.equal(selected.selected,true);
  assert.equal((await h.json('/api/themes/audit/config',{enabled:false,removed:{kept:true}})).status,204);
  assert.deepEqual(await (await h.fetch('/api/themes/audit/config')).json(),{enabled:false,removed:{kept:true}});
  assert.equal((await h.json('/api/themes/audit/config',{enabled:'bad'})).status,400);
  assert.equal((await h.json('/api/themes/audit/config',{})).status,204);assert.deepEqual(await (await h.fetch('/api/themes/audit/config')).json(),{});
  const preview=await h.fetch('/api/themes/audit/preview',{headers:h.auth});assert.equal(preview.status,200);assert.equal(preview.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
  assert.equal((await h.fetch('/api/themes/audit',{method:'DELETE',headers:h.auth})).status,204);
  const settings=await (await h.fetch('/api/settings',{headers:h.auth})).json();assert.equal(settings.theme,'audit');assert.equal(settings.site_name,'A site');
  const after=await (await h.fetch('/api/themes',{headers:h.auth})).json();assert.equal(after.themes.find(x=>x.short==='default').selected,true);
  assert.equal((await h.fetch('/api/themes/default',{method:'DELETE',headers:h.auth})).status,400);
  assert.equal((await h.fetch('/api/themes/audit',{method:'DELETE',headers:h.auth})).status,400,'fixed source rejects missing directories, not idempotent');
  assert.match(await (await h.fetch(`/static/audit.js?monitor_revision=${theme.revision}`)).text(),/original 1/);
  evidence('rest-lifecycle',{list,selected,settings,after,revision:theme.revision});
});

test('theme settings and management enforce real admin, CSRF, Turnstile, expiry and safe string-map validation',async t=>{
  const h=await fixture(t);await h.whole(archive());
  for(const path of ['/api/themes','/api/settings','/api/themes/audit/preview']) {const r=await h.fetch(path);assert.equal(r.status,401);assert.match(r.headers.get('Content-Type'),/^text\/plain/);}
  assert.equal((await h.json('/api/settings',{theme:'audit'},'PUT',{Cookie:h.auth.Cookie,Origin:'https://evil.test'})).status,403);
  for(const body of [{public_page:false},{theme:'audit',site_name:2},{theme:'audit',jwt_secret:'leak'},{retention_days:'365'},{github_proxy:'https://example.test'}])assert.ok((await h.json('/api/settings',body)).status>=400);
  const state=await (await h.fetch('/api/settings',{headers:h.auth})).json();assert.equal(state.theme,'default');assert.doesNotMatch(JSON.stringify(state),/jwt_secret|cloudflare_token|terminal_enabled|s2-test-only/);
  await h.db.prepare("UPDATE settings SET value=json_set(value,'$.turnstile_enabled','true','$.turnstile_secret_key','private','$.turnstile_site_key','public') WHERE key='site_options'").run();
  assert.equal((await h.fetch('/api/themes',{headers:h.auth})).status,403);
  await h.db.prepare("UPDATE settings SET value=json_set(value,'$.turnstile_enabled','false') WHERE key='site_options'").run();
  const p=JSON.parse(Buffer.from(h.token.split('.')[1],'base64').toString());await h.db.prepare('INSERT INTO terminal_auth_sessions VALUES(?,?,?)').bind(p.jti,p.exp,Date.now()).run();
  assert.equal((await h.json('/api/settings',{theme:'audit'})).status,401);
  evidence('rest-auth',{anonymous:401,crossOrigin:403,turnstile:403,revoked:401,settings:state});
});

test('offset-total upload is owner isolated, continuous, retryable after fault and only publishes validated final archives',async t=>{
  const h=await fixture(t),bytes=archive(),half=Math.floor(bytes.length/2);
  const first=await h.upload(bytes.subarray(0,half),0,bytes.length);assert.equal(first.status,200);assert.deepEqual(await first.json(),{received:half});
  assert.ok(!(await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.some(x=>x.short==='audit'));
  assert.equal((await h.upload(bytes.subarray(half),half,bytes.length,h.otherAuth)).status,400);
  assert.equal((await h.upload(bytes.subarray(half),half-1,bytes.length)).status,400);
  assert.equal((await h.upload(bytes.subarray(half),half,bytes.length+1)).status,400);
  await h.db.prepare("CREATE TRIGGER fail_s2_upload BEFORE INSERT ON monitor_theme_upload_chunks BEGIN SELECT RAISE(ABORT,'controlled D1 failure'); END").run();
  assert.equal((await h.upload(bytes.subarray(half),half,bytes.length)).status,503);await h.db.prepare('DROP TRIGGER fail_s2_upload').run();
  const end=await h.upload(bytes.subarray(half),half,bytes.length);assert.equal(end.status,200);const installed=await end.json();assert.equal(installed.theme.short,'audit');
  assert.equal((await h.upload(Buffer.from('garbage'))).status,400);
  const current=(await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(x=>x.short==='audit');assert.equal(current.revision,installed.theme.revision);
  assert.equal((await h.upload(bytes,0,0)).status,400);assert.equal((await h.upload(bytes,0,33554433)).status,413);assert.equal((await h.upload(bytes,1,1)).status,400);
  evidence('chunk-lifecycle',{received:half,installed,unchanged:current,ownerDenied:400,storageFault:503,retry:200});
});

test('two uploads begun against the same short/revision cannot publish over one another',async t=>{
  const h=await fixture(t);const prior=await h.whole(archive());const a=archive({...meta,version:'2'}),b=archive({...meta,version:'3'}),split=80;
  assert.equal((await h.upload(a.subarray(0,split),0,a.length)).status,200);
  assert.equal((await h.upload(b.subarray(0,split),0,b.length,h.otherAuth)).status,200);
  const responses=await Promise.all([h.upload(a.subarray(split),split,a.length),h.upload(b.subarray(split),split,b.length,h.otherAuth)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);const bodies=await Promise.all(responses.map(r=>r.text()));
  const current=(await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(x=>x.short==='audit');assert.ok(['2','3'].includes(current.version));
  assert.match(await (await h.fetch(`/static/audit.js?monitor_revision=${prior.revision}`)).text(),/original 1/);
  evidence('chunk-concurrency',{statuses:responses.map(r=>r.status),bodies,current,prior});
});

test('original static/manifest namespace and pinned preview survive selection changes and deep refresh without claiming CF paths',async t=>{
  const h=await fixture(t),old=await h.whole(archive());await h.json('/api/settings',{theme:'audit'});
  const page=await h.fetch('/'),html=await page.text();assert.match(html,/src="\/static\/audit.js"/);
  const ref=origin+`/?monitor_revision=${old.revision}`;
  for(const [path,expected] of [['/static/audit.js','console.log("original 1")'],['/manifest.json','{"name":"original manifest"}'],['/os-icons/test.svg','<svg>original OS</svg>']]){
    assert.equal(await (await h.fetch(path,{headers:{Referer:ref}})).text(),expected);
    assert.equal(await (await h.fetch(path,{headers:{Referer:origin+'/admin'}})).text(),'CF '+path);
  }
  await h.json('/api/settings',{theme:'default'});
  assert.equal(await (await h.fetch(`/static/audit.js?monitor_revision=${old.revision}`)).text(),'console.log("original 1")');
  const previewHeaders={Cookie:`cfsm_theme_preview_auth=${h.token}`};const pinned=`monitor_preview=audit&monitor_revision=${old.revision}`;
  for(const path of ['/', '/nested/deep/route']) {const r=await h.fetch(path+'?'+pinned,{headers:previewHeaders});assert.equal(r.status,200);assert.match(await r.text(),/audit/);}
  assert.equal((await h.fetch('/nested/deep/route?'+pinned)).status,401);
  assert.equal((await h.fetch(`/static/audit.js?monitor_preview=default&monitor_revision=${old.revision}`,{headers:previewHeaders})).status,404);
  for(const path of ['/nested/api/thing','/_monitor_theme/secret','/static%2Faudit.js','/static/%255csecret','/static/%00bad']) {const r=await h.fetch(path);assert.ok(r.status>=400,`${path}: ${r.status}`);assert.doesNotMatch(await r.text(),/<html>/);}
  assert.equal(await (await h.fetch('/install.sh?'+pinned,{headers:previewHeaders})).text(),'CF /install.sh');
  evidence('namespace',{html,revision:old.revision,pinned,deepRefresh:200,withoutAuth:401});
});

test('standard node CRUD/order/token/public remark and probe CRUD/assignment/order map to the same CF business',async t=>{
  const h=await fixture(t);const created=await h.json('/api/nodes',{name:'native admin node',public:true,group:'Web',public_remark:'visible remark'},'POST');assert.equal(created.status,200);
  const {id}=await created.json();assert.ok(Number.isSafeInteger(id));
  let node=(await (await h.fetch('/api/nodes')).json()).nodes.find(n=>n.id===id);assert.equal(node.public_remark,'visible remark');assert.equal(node.group,'Web');
  assert.equal((await h.json(`/api/nodes/${id}`,{public_remark:'changed',remark:'private',price:12,expires_at:null})).status,200);
  node=(await (await h.fetch('/api/nodes')).json()).nodes.find(n=>n.id===id);assert.equal(node.public_remark,'changed');assert.doesNotMatch(JSON.stringify(node),/private/);
  const credential=await h.fetch(`/api/nodes/${id}/token`,{headers:h.auth});assert.equal(credential.status,200);const token=(await credential.json()).token;assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal((await h.fetch(`/api/nodes/${id}/token`)).status,401);
  const reset=await h.fetch(`/api/nodes/${id}/token`,{method:'POST',headers:h.auth});assert.equal(reset.status,200);assert.notEqual((await reset.json()).token,token);
  assert.equal((await h.json('/api/nodes/order',{ids:[id]})).status,200);assert.equal((await h.json('/api/nodes/order',{ids:[id,id]})).status,400);
  const ping=await h.json('/api/ping-tasks',{name:'TCP',target:'example.test:443',interval:60,nodes:[id],auto_join:false},'POST');assert.equal(ping.status,200);const taskId=(await ping.json()).id;
  const list=await (await h.fetch('/api/ping-tasks',{headers:h.auth})).json();assert.deepEqual(list.tasks.map(x=>x.id),[taskId]);assert.deepEqual(list.tasks[0].nodes,[id]);
  assert.equal((await h.json(`/api/nodes/${id}/ping-tasks`,{tasks:[],base:[taskId]})).status,200);
  assert.equal((await h.json(`/api/nodes/${id}/ping-tasks`,{tasks:[9999],base:[]})).status,400);
  assert.equal((await h.json('/api/ping-tasks/order',{ids:[taskId]})).status,200);
  const changed=await h.json('/api/ping-tasks',{id:taskId,name:'changed TCP',target:'example.test:444',interval:30,nodes:[id],base:[],auto_join:false},'POST');assert.equal(changed.status,200);
  const newId=(await changed.json()).id;assert.notEqual(newId,taskId,'target changes reserve a new immutable probe generation');
  const oldDelete=await h.fetch(`/api/ping-tasks/${taskId}`,{method:'DELETE',headers:h.auth});assert.equal(oldDelete.status,404);
  assert.equal((await h.fetch(`/api/ping-tasks/${newId}`,{method:'DELETE',headers:h.auth})).status,200);
  assert.equal((await h.fetch(`/api/nodes/${id}`,{method:'DELETE',headers:h.auth})).status,200);
  assert.equal((await h.fetch(`/api/nodes/${id}/token`,{headers:h.auth})).status,404);
  assert.equal((await h.json('/api/nodes',{name:'second'},'POST')).status,200);
  const next=(await (await h.fetch('/api/nodes')).json()).nodes[0];assert.notEqual(next.id,id,'deleted public IDs stay reserved');
  const unsupported=await h.json(`/api/nodes/${next.id}/traffic`,{total_rx:1});assert.equal(unsupported.status,501);assert.match(unsupported.headers.get('Content-Type'),/^text\/plain/);
  evidence('admin-business',{id,node,taskId,list,tokenRotated:true,deletedToken:404,nonReusedId:next.id,correctionUnsupported:501});
});

test('preview API and icon theme escape keep their own context after site selection and icon override changes',async t=>{
  const h=await fixture(t),theme=await h.whole(archive());
  const query=`monitor_preview=audit&monitor_revision=${theme.revision}`;
  assert.equal((await h.fetch('/api/themes/audit/config?'+query)).status,401);
  const previewCookie={Cookie:`cfsm_theme_preview_auth=${h.token}`};assert.equal((await h.fetch('/api/themes/audit/config?'+query,{headers:previewCookie})).status,200);
  await h.json('/api/settings',{theme:'audit',favicon:'data:image/png;base64,'+png.toString('base64')});
  const escaped=await h.fetch('/favicon.svg?theme',{headers:{Referer:origin+'/?monitor_revision='+theme.revision}});assert.equal(escaped.status,200);assert.equal(await escaped.text(),'<svg>theme icon</svg>');
  await h.whole(archive({...meta,version:'2'}));
  const old=await h.fetch('/nested/deep?'+query,{headers:previewCookie});assert.equal(old.status,200);assert.match(await old.text(),new RegExp(theme.revision));
  const second=(await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(t=>t.short==='audit');assert.notEqual(second.revision,theme.revision);
  evidence('preview-context',{unauthorizedConfig:401,authorizedConfig:200,escapedThemeIcon:true,old:theme.revision,current:second.revision});
});

test('logout during a real chunk transaction cannot publish the upload under stale authority',async t=>{
  const h=await fixture(t),bytes=archive(),split=90;
  assert.equal((await h.upload(bytes.subarray(0,split),0,bytes.length)).status,200);
  const principal=JSON.parse(Buffer.from(h.token.split('.')[1],'base64').toString());
  await h.db.prepare('INSERT INTO terminal_auth_sessions VALUES(?,?,NULL)').bind(principal.jti,principal.exp).run();
  await h.db.prepare("CREATE TRIGGER revoke_s2_upload AFTER INSERT ON monitor_theme_upload_chunks BEGIN UPDATE terminal_auth_sessions SET revoked_at=1; END").run();
  const result=await h.upload(bytes.subarray(split),split,bytes.length);assert.equal(result.status,401);
  const registry=await h.db.prepare("SELECT value FROM settings WHERE key='monitor_theme_packages'").first();assert.equal(registry,null);
  evidence('upload-revocation',{status:result.status,published:false});
});

test('native creation failure rolls back identity/config and old CF edit keeps all original fields',async t=>{
  const h=await fixture(t);
  await h.db.prepare("CREATE TRIGGER fail_s2_credential BEFORE INSERT ON terminal_nodes BEGIN SELECT RAISE(ABORT,'controlled credential failure'); END").run();
  const failed=await h.json('/api/nodes',{name:'must rollback',public_remark:'not partial'},'POST');assert.ok(failed.status>=400);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM servers').first()).n,0);
  await h.db.prepare('DROP TRIGGER fail_s2_credential').run();
  const add=await h.json('/admin/api',{action:'add',name:'CF old'},'POST');assert.equal(add.status,200);const uuid=(await add.json()).id;
  const edit=await h.json('/admin/api',{action:'edit',id:uuid,name:'CF changed',server_group:'CF',region:'US',collect_interval:0,report_interval:60,wss_report_interval:2,connection_mode:'http',ping_mode:'tcp',reset_day:1,public_remark:'shared setter'},'POST');assert.equal(edit.status,200);
  const row=await h.db.prepare('SELECT name,server_group,public_remark FROM servers WHERE id=?').bind(uuid).first();assert.deepEqual(row,{name:'CF changed',server_group:'CF',public_remark:'shared setter'});
  evidence('shared-node-business',{failed:failed.status,rolledBack:true,row});
});

test('management reads fail closed on D1 faults and previews lose authorization immediately at logout',async t=>{
  const h=await fixture(t),theme=await h.whole(archive());
  const query=`monitor_preview=audit&monitor_revision=${theme.revision}`,cookie={Cookie:`cfsm_theme_preview_auth=${h.token}`};
  assert.equal((await h.fetch('/nested?'+query,{headers:cookie})).status,200);
  const p=JSON.parse(Buffer.from(h.token.split('.')[1],'base64').toString());await h.db.prepare('INSERT INTO terminal_auth_sessions VALUES(?,?,?)').bind(p.jti,p.exp,Date.now()).run();
  assert.equal((await h.fetch('/nested?'+query,{headers:cookie})).status,401);
  await h.db.prepare('DELETE FROM terminal_auth_sessions').run();
  await h.json('/api/themes/audit/config',{enabled:false});
  await h.db.prepare("UPDATE settings SET value='not-json' WHERE key='monitor_theme_config:audit'").run();
  const config=await h.fetch('/api/themes/audit/config',{headers:h.auth});assert.equal(config.status,503);assert.notEqual(await config.text(),'{}');
  const settings=await h.fetch('/api/settings',{headers:h.auth});assert.equal(settings.status,503);
  evidence('faults-preview-logout',{previewRevoked:401,configFault:503,settingsFault:503});
});

test('native text registration returns bare token, held token precedes closed window, CF JSON identity remains unchanged',async t=>{
  const h=await fixture(t),opened=await h.fetch('/api/register-window',{method:'POST',headers:h.auth});assert.equal(opened.status,200);
  const window=await opened.json();assert.match(window.register_key,/^[a-f0-9]{64}$/);assert.ok(window.register_left<=900&&window.register_left>890);
  const send=(body,headers={})=>h.fetch('/api/agent/register',{method:'POST',headers:{Authorization:`Bearer ${window.register_key}`,'Content-Type':'text/plain',...headers},body});
  const r=await send('native-one');assert.equal(r.status,200);assert.match(r.headers.get('Content-Type'),/^text\/plain/);const token=await r.text();assert.match(token,/^[a-f0-9]{64}$/);
  const before=await h.db.prepare('SELECT COUNT(*) AS n FROM servers').first();
  assert.equal((await h.fetch('/api/register-window',{method:'DELETE',headers:h.auth})).status,204);
  assert.equal(await (await send('renamed',{'X-Node-Token':token,Authorization:'Bearer wrong'})).text(),token);
  assert.deepEqual(await h.db.prepare('SELECT COUNT(*) AS n FROM servers').first(),before);
  const closed=await send('another');assert.equal(closed.status,403);assert.match(closed.headers.get('Content-Type'),/^text\/plain/);
  const row=await h.db.prepare("SELECT id FROM servers WHERE name='native-one'").first();await issueNodeToken(h.db,row.id,Date.now(),secret);
  assert.equal((await send('revoked',{'X-Node-Token':token})).status,403);
  const cfWindow=await h.fetch('/api/register-window',{method:'POST',headers:h.auth});const key=(await cfWindow.json()).register_key;
  const cf=await h.fetch('/api/agent/register',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({name:'cf-node'})});assert.equal(cf.status,200);assert.deepEqual(Object.keys(await cf.json()).sort(),['serverId','token']);
  evidence('registration',{window,nativeTokenShape:'64hex',before,heldNoNewNode:true,closed:403,rotatedHeld:403,cfShape:['serverId','token']});
});

test('site icons are validated data images, override native paths and allow exact theme escape without changing admin context',async t=>{
  const h=await fixture(t);await h.whole(archive());await h.json('/api/settings',{theme:'audit'});
  const icon='data:image/png;base64,'+png.toString('base64');assert.equal((await h.json('/api/settings',{favicon:icon,touch_icon:icon})).status,200);
  for(const path of ['/favicon.svg','/favicon.ico','/apple-touch-icon.png','/apple-touch-icon-precomposed.png']){const r=await h.fetch(path);assert.equal(r.headers.get('Content-Type'),'image/png');assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);}
  assert.equal(await (await h.fetch('/favicon.svg?theme')).text(),'<svg>theme icon</svg>');
  assert.deepEqual(Buffer.from(await (await h.fetch('/favicon.svg?theme=1')).arrayBuffer()),png);
  assert.equal(await (await h.fetch('/favicon.svg',{headers:{Referer:origin+'/admin'}})).text(),'CF /favicon.svg');
  assert.equal((await h.json('/api/settings',{favicon:'https://evil.test/image'})).status,400);
  assert.equal((await h.json('/api/settings',{touch_icon:'data:image/png;base64,'+Buffer.alloc(20481).toString('base64')})).status,400);
  const svg='data:image/svg+xml;base64,'+Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64');assert.equal((await h.json('/api/settings',{favicon:svg})).status,200);
  const served=await h.fetch('/favicon.svg');assert.match(served.headers.get('Content-Security-Policy'),/sandbox/);evidence('icons',{png:true,themeEscape:true,adminOwn:true,svgSandbox:served.headers.get('Content-Security-Policy')});
});

test('upload restart cancels only owner temporary chunks; streaming overflow and invalid final never alter published revisions',async t=>{
  const h=await fixture(t),bytes=archive(),split=90;
  assert.equal((await h.upload(bytes.subarray(0,split),0,bytes.length)).status,200);
  assert.equal((await h.upload(bytes.subarray(0,split),0,bytes.length)).status,200,'offset0 restarts partial upload');
  const first=await h.upload(bytes.subarray(split),split,bytes.length);assert.equal(first.status,200);const theme=(await first.json()).theme;
  const overflow=await h.upload(Buffer.alloc(8*1024*1024+1),0,32*1024*1024);assert.equal(overflow.status,413);
  const bad=await h.upload(bytes.subarray(0,bytes.length-10),0,bytes.length-10);assert.equal(bad.status,400);
  assert.equal((await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(t=>t.short==='audit').revision,theme.revision);
  const temp=await h.db.prepare('SELECT COUNT(*) AS n FROM monitor_theme_upload_chunks').first();assert.equal(temp.n,0);
  assert.equal((await h.upload(bytes,0,bytes.length,{Origin:origin})).status,401);
  evidence('upload-limits',{restart:200,overflow:413,invalidFinal:400,publishedRevision:theme.revision,temporaryParts:temp.n});
});

test('actual GitHub HTTP install/update checks version, short and async revision CAS without proxying secrets',async t=>{
  let version='1',downloaded=0,short='audit',hold=false,releaseDownload,started;
  const calls=[];
  const h=await fixture(t,{outboundService:async request=>{
    const url=new URL(request.url);calls.push({url:url.toString(),authorization:request.headers.get('Authorization')});
    if(url.pathname.endsWith('/releases/latest'))return new Response(null,{status:302,headers:{Location:`https://github.com/fixture/audit/releases/tag/v${version}`}});
    downloaded++;if(hold){started?.();await new Promise(resolve=>{releaseDownload=resolve;});}
    return new Response(archive({...meta,version,short}),{headers:{'Content-Type':'application/gzip'}});
  }});
  const installed=await h.json('/api/theme-install',{url:'github.com/fixture/audit/releases'},'POST');assert.equal(installed.status,200);assert.equal((await installed.json()).theme.version,'1');
  const update=()=>h.fetch('/api/themes/audit/update',{method:'POST',headers:h.auth});
  assert.deepEqual(await (await update()).json(),{updated:false,version:'1'});assert.equal(downloaded,1);
  version='2';assert.deepEqual(await (await update()).json(),{updated:true,version:'2'});
  short='wrong';version='3';assert.equal((await update()).status,400);short='audit';
  hold=true;const waiting=new Promise(resolve=>{started=resolve;});const pending=update();await waiting;
  const replacement=await h.whole(archive({...meta,version:'manual'}));hold=false;releaseDownload();const conflict=await pending;assert.equal(conflict.status,409);
  const latest=(await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(t=>t.short==='audit');assert.equal(latest.revision,replacement.revision);
  hold=true;const installStarted=new Promise(resolve=>{started=resolve;});const delayedInstall=h.json('/api/theme-install',{url:'https://github.com/fixture/audit'},'POST');await installStarted;
  const newest=await h.whole(archive({...meta,version:'newest'}));hold=false;releaseDownload();assert.equal((await delayedInstall).status,409);
  assert.equal((await (await h.fetch('/api/themes',{headers:h.auth})).json()).themes.find(t=>t.short==='audit').revision,newest.revision);
  assert.ok(calls.every(c=>!c.authorization));assert.equal((await h.json('/api/theme-install',{url:'https://evil.test/archive'},'POST')).status,400);
  evidence('repository-http',{calls,downloaded,sameVersionNoDownload:true,shortDenied:400,asyncConflict:409,standaloneInstallConflict:409,latest});
});

test('native node setters preserve exact allowance, ISO currency/direction, omitted CF values and batch notify/group',async t=>{
  const h=await fixture(t);const created=await h.json('/api/nodes',{name:'semantics',price:3,currency:'EUR',traffic_mode:'up',group:'first'},'POST');assert.equal(created.status,200);const {id}=await created.json();
  const response=await h.fetch(`/api/nodes/${id}`,{method:'PUT',headers:{...h.auth,'Content-Type':'application/json'},body:'{"traffic_limit":9007199254740993,"public_remark":"exact"}'});assert.equal(response.status,200);
  const raw=await (await h.fetch('/api/nodes')).text();assert.match(raw,/"traffic_limit":9007199254740993[,}]/);const node=JSON.parse(raw).nodes[0];assert.equal(node.currency,'EUR');assert.equal(node.traffic_mode,'up');assert.equal(node.group,'first');
  assert.equal((await h.json(`/api/nodes/${id}`,{expires_at:'2026-11-31'})).status,400);
  assert.equal((await h.json('/api/nodes/batch',{ids:[id],patch:{notify:true,group:'second'}})).status,200);
  const dedup=await h.json('/api/nodes/batch',{ids:[id,id],patch:{group:'dedup'}});assert.equal(dedup.status,200);assert.deepEqual(await dedup.json(),{updated:1});
  assert.equal((await h.json('/api/nodes/batch',{ids:[id,999999],patch:{group:'must not change'}})).status,404);
  await h.json('/api/nodes/batch',{ids:[id],patch:{group:'second'}});
  const row=await h.db.prepare('SELECT server_group,offline_notify_disabled,public_remark FROM servers').first();assert.deepEqual(row,{server_group:'second',offline_notify_disabled:'0',public_remark:'exact'});
  evidence('native-setter-semantics',{raw,row});
});

test('native empty group and live complete-order guard remain correct if a node appears during the transaction',async t=>{
  const h=await fixture(t);const added=await h.json('/api/nodes',{name:'no group'},'POST');assert.equal(added.status,200);const {id}=await added.json();
  const row=await h.db.prepare('SELECT id,server_group FROM servers').first();assert.equal(row.server_group,'');
  await h.db.prepare(`CREATE TRIGGER change_s2_order BEFORE UPDATE OF sort_order ON servers BEGIN INSERT OR IGNORE INTO servers(id,name,sort_order) VALUES('late','late',99); END`).run();
  const ordered=await h.json('/api/nodes/order',{ids:[id]});assert.equal(ordered.status,400);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS n FROM servers WHERE id='late'").first()).n,0,'failed order rolls back intervening trigger write');
  evidence('order-atomic',{emptyGroup:row.server_group,staleOrder:400,atomicRollback:true});
});

test('native registration rejects stale held tokens after deletion/authority change and preserves CF discovery-off reinstall',async t=>{
  const h=await fixture(t);const opened=await h.fetch('/api/register-window',{method:'POST',headers:h.auth}),key=(await opened.json()).register_key;
  const native=()=>h.fetch('/api/agent/register',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'text/plain'},body:'held'});
  const token=await (await native()).text();const existing=await h.db.prepare("SELECT id FROM servers WHERE name='held'").first();
  await h.json('/api/settings',{auto_discovery:'false'});
  const held=()=>h.fetch('/api/agent/register',{method:'POST',headers:{'X-Node-Token':token,'Content-Type':'text/plain'},body:'same'});
  assert.equal(await (await held()).text(),token);assert.equal((await native()).status,403);
  await h.db.prepare('DELETE FROM servers WHERE id=?').bind(existing.id).run();assert.equal((await held()).status,403);
  const count=await h.db.prepare('SELECT COUNT(*) AS n FROM servers').first();assert.equal(count.n,0);
  evidence('held-token-deletion',{heldDiscoveryOff:200,freshDiscoveryOff:403,deletedHeld:403,nodeCount:count.n});
});

test('native reset-day creation writes the same reporting intent and settings images survive metadata backup',async t=>{
  const h=await fixture(t);const response=await h.json('/api/nodes',{name:'period',traffic_reset_day:29},'POST');assert.equal(response.status,200);
  const row=await h.db.prepare('SELECT id,reset_day FROM servers').first();assert.equal(row.reset_day,29);
  const reporting=await h.db.prepare("SELECT value FROM settings WHERE key=?").bind('monitor_reporting:'+row.id).first();assert.equal(JSON.parse(reporting?.value||'{}').resetDay,29);
  const icon='data:image/png;base64,'+png.toString('base64');await h.json('/api/settings',{favicon:icon,touch_icon:icon});
  const backup=await h.json('/admin/api',{action:'export_servers'},'POST');assert.equal(backup.status,200);const saved=await backup.json();assert.equal(saved.settings.appearance.touch_icon,icon);
  evidence('settings-backup-reporting',{resetDay:29,reporting:JSON.parse(reporting.value),touchIconPreserved:true});
});

test('approved platform gaps return actual unsupported text and keep CF auth/install entry points available',async t=>{
  const h=await fixture(t),out=[];
  for(const [method,path] of [['POST','/api/auth/login'],['GET','/api/auth/github'],['GET','/api/auth/github/callback'],['GET','/api/sessions'],['DELETE','/api/sessions/old'],['GET','/api/db'],['GET','/api/db/backup'],['POST','/api/db/restore'],['POST','/api/db/vacuum'],['GET','/api/version'],['GET','/api/agent/echo']]) {
    const r=await h.fetch(path,{method,headers:h.auth});assert.equal(r.status,501,`${method} ${path}`);assert.match(r.headers.get('Content-Type'),/^text\/plain/);out.push({method,path,status:r.status,body:await r.text()});
  }
  const logout=await h.fetch('/api/auth/logout',{method:'POST',headers:h.auth});assert.equal(logout.status,200);assert.deepEqual(await logout.json(),{ok:true});
  assert.equal((await h.fetch('/api/themes',{headers:h.auth})).status,401);assert.equal(await (await h.fetch('/install.sh')).text(),'CF /install.sh');
  evidence('unsupported-inventory',{out,logout:200,revoked:401,originalCFInstall:true});
});

test('native settings read fresh values and a D1 failure cannot partially change site, icon or selection',async t=>{
  const h=await fixture(t);await h.whole(archive());
  await h.json('/api/settings',{site_name:'old'});
  await h.db.prepare("UPDATE settings SET value=json_set(value,'$.site_title','fresh') WHERE key='appearance_options'").run();
  assert.equal((await (await h.fetch('/api/settings',{headers:h.auth})).json()).site_name,'fresh');
  await h.db.prepare("CREATE TRIGGER fail_s2_settings BEFORE UPDATE ON settings WHEN OLD.key='appearance_options' BEGIN SELECT RAISE(ABORT,'controlled settings fault'); END").run();
  const result=await h.json('/api/settings',{theme:'audit',site_name:'must rollback',public_page:'off'});assert.equal(result.status,503);
  const state=await h.db.prepare("SELECT json_extract(value,'$.is_public') AS public FROM settings WHERE key='site_options'").first();assert.equal(state.public,'true');
  await h.db.prepare('DROP TRIGGER fail_s2_settings').run();
  const settings=await (await h.fetch('/api/settings',{headers:h.auth})).json();assert.equal(settings.theme,'default');assert.equal(settings.site_name,'fresh');
  evidence('settings-atomic',{freshRead:true,fault:503,settings,publicUnchanged:state.public});
});

test('two simultaneous final chunks for one owner have one commit and a cancelled HTTP body leaves the offset retryable',async t=>{
  const h=await fixture(t),bytes=archive(),split=90;
  await h.upload(bytes.subarray(0,split),0,bytes.length);
  const aborted=new ReadableStream({start(c){c.enqueue(bytes.subarray(split,split+20));c.error(new Error('controlled client cancellation'));}});
  await assert.rejects(()=>h.fetch(`/api/themes?offset=${split}&total=${bytes.length}`,{method:'POST',headers:{...h.auth,'Content-Type':'application/octet-stream'},body:aborted,duplex:'half'}));
  assert.equal((await h.db.prepare('SELECT received FROM monitor_theme_uploads').first()).received,split);
  const results=await Promise.all([h.upload(bytes.subarray(split),split,bytes.length),h.upload(bytes.subarray(split),split,bytes.length)]);
  assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.find(r=>r.status!==200).status>=400);
  const releases=await h.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'monitor_theme_release:%'").first();assert.equal(releases.n,1);
  evidence('same-owner-cancellation',{offsetAfterCancel:split,statuses:results.map(r=>r.status),publishedReleases:releases.n});
});

test('real multi-megabyte chunked upload restores complete original binary ranges through revision-bound HTTP',async t=>{
  const h=await fixture(t),binary=randomBytes(5*1024*1024+31);
  const bytes=gzipSync(Buffer.concat([entry('theme.json',JSON.stringify(meta)),entry('dist/index.html','<html><head></head><body>large original</body></html>'),entry('dist/static/blob.bin',binary),Buffer.alloc(1024)]));
  const size=4*1024*1024,first=await h.upload(bytes.subarray(0,size),0,bytes.length);assert.deepEqual(await first.json(),{received:size});
  const final=await h.upload(bytes.subarray(size),size,bytes.length);assert.equal(final.status,200);const theme=(await final.json()).theme;
  const downloaded=await h.fetch(`/static/blob.bin?monitor_revision=${theme.revision}`);assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('Content-Type'),/^application\/octet-stream/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),binary);
  const stats=await h.db.prepare('SELECT COUNT(*) AS parts,MAX(length(data)) AS max FROM monitor_theme_chunks').first();assert.ok(stats.parts>8);assert.equal(stats.max,524288);
  evidence('large-binary-http',{compressedBytes:bytes.length,firstReceived:size,binaryBytes:binary.length,stats,revision:theme.revision,exactOriginalBytes:true});
});

test('notify REST sends saved enabled channels and reports real transport failure, not empty success',async t=>{
  let status=200;const h=await fixture(t,{outboundService:async()=>new Response('ok',{status})});
  const send=()=>h.fetch('/api/notify/test',{method:'POST',headers:h.auth});assert.equal((await send()).status,400);
  const config={schema:1,revision:1,timezone:'UTC',language:'en',channels:[{id:'web',name:'Saved webhook',type:'webhook',enabled:true,config:{method:'POST',format:'json',body:'{"message":"{{message}}"}'},secrets:{url:'https://notify.example.test/hook',headers:'{}'},template:'{{message}}'}],rules:[]};
  await h.db.prepare("INSERT INTO settings(key,value) VALUES('notification_config',?)").bind(JSON.stringify(config)).run();
  const delivered=await send();assert.equal(delivered.status,200);assert.deepEqual(await delivered.json(),{sent:['Saved webhook']});
  status=500;assert.equal((await send()).status,502);evidence('notify-http',{empty:400,delivered:['Saved webhook'],failed:502});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { installMonitorTheme, removeMonitorTheme, readMonitorThemeFile } from '../src/services/monitorThemePackages.js';
import { loadMonitorThemes, selectMonitorTheme, saveMonitorThemeConfig, importMonitorThemes, exportMonitorThemes } from '../src/services/monitorThemes.js';
import { parseMonitorThemeArchive } from '../src/shared/monitorThemeArchive.js';
import { monitorConfigForm, monitorConfigValues, monitorConfigOverrides, validMonitorThemeBackup } from '../src/shared/monitorThemes.js';
import worker from '../src/index.js';
import { generateToken } from '../src/middleware/auth.js';
import { installMonitorRepository, parseMonitorRepository } from '../src/services/monitorThemeRepository.js';

const manifest = { name:'Original third theme',short:'third',description:'Native package',version:'1.0',author:'fixture',url:'https://github.com/example/native-theme',config:[
  {type:'title',label:'Appearance'},{key:'enabled',type:'boolean',default:true},{key:'style',type:'select',default:'a',options:[{value:'a'},{value:'b'}]},
  {key:'label',type:'string',default:''},{key:'note',type:'text',default:''},{key:'size',type:'number',default:3,min:1,max:8}
] };
function tarEntry(name,body,type='0') {
  const data=Buffer.from(body),header=Buffer.alloc(512);
  header.write(name,0,100,'utf8');header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
  header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write(type,156);header.write('ustar\0',257);
  const sum=header.reduce((total,value)=>total+value,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return Buffer.concat([header,data,Buffer.alloc((512-data.length%512)%512)]);
}
export function packageBytes(meta=manifest,entries=[]) {
  return gzipSync(Buffer.concat([tarEntry('theme.json',JSON.stringify(meta)),tarEntry('dist/index.html','<html><head><script type="module" src="/assets/app.js"></script></head><body>native</body></html>'),
    tarEntry('dist/assets/app.js','export const native = true'),tarEntry('dist/fonts/font.woff2','font'),...entries,Buffer.alloc(1024)]));
}
const stream=bytes=>new Blob([bytes]).stream();
async function fixture(t) {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response();}}',d1Databases:{DB:'ecosystem'}});
  t.after(()=>mf.dispose());
  const DB=await mf.getD1Database('DB');await DB.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT)').run();
  return {DB};
}

test('native third-party install/select/update/delete uses one registry and keeps old revision assets/configuration',async t=>{
  const env=await fixture(t);
  const first=await installMonitorTheme(env,stream(packageBytes()));
  const state=await loadMonitorThemes(env.DB);
  assert.ok(state.themes.some(theme=>theme.short==='third'));
  assert.equal(state.effective,'default','installation does not activate');
  await selectMonitorTheme(env.DB,'third');
  await saveMonitorThemeConfig(env.DB,'third',{enabled:false,style:'b',size:5,label:'hello',note:'multiline\ntext'});
  assert.equal((await loadMonitorThemes(env.DB)).effective,'third');
  const response=await readMonitorThemeFile(env,'third','fonts/font.woff2',first.revision);
  assert.equal(await response.text(),'font');
  assert.equal(response.headers.get('Content-Type'),'font/woff2');
  const second=await installMonitorTheme(env,stream(packageBytes({...manifest,version:'2.0'})),{expectedShort:'third'});
  assert.notEqual(second.revision,first.revision);
  assert.deepEqual((await loadMonitorThemes(env.DB)).configs.third,{enabled:false,style:'b',size:5,label:'hello',note:'multiline\ntext'});
  assert.equal(await (await readMonitorThemeFile(env,'third','assets/app.js',first.revision)).text(),'export const native = true');
  await assert.rejects(()=>installMonitorTheme(env,stream(packageBytes({...manifest,short:'other'})),{expectedShort:'third'}),/monitorTheme/);
  await removeMonitorTheme(env,'third');
  const removed=await loadMonitorThemes(env.DB);assert.equal(removed.effective,'default');assert.equal(removed.selected,'third');
  assert.equal(removed.configs.third.enabled,false,'delete retains per-short override');
  assert.equal(await (await readMonitorThemeFile(env,'third','assets/app.js',first.revision)).text(),'export const native = true','already-open asset revisions survive removal');
});

test('gzip/tar admission rejects corrupt, nested, traversal, duplicate and non-file entries without publishing',async t=>{
  const env=await fixture(t);
  for(const bytes of [Buffer.from('not a package'),gzipSync(Buffer.concat([tarEntry('source/theme.json','{}'),Buffer.alloc(1024)])),packageBytes(manifest,[tarEntry('../outside','x')]),
    packageBytes(manifest,[tarEntry('dist/linked','/secret','2')]),packageBytes(manifest,[tarEntry('dist/assets/app.js','replace')]),packageBytes().subarray(0,80)]) {
    await assert.rejects(()=>installMonitorTheme(env,stream(bytes)),/monitorTheme/);
    assert.equal((await loadMonitorThemes(env.DB)).themes.length,2);
  }
  const bad=Buffer.concat([tarEntry('theme.json',JSON.stringify(manifest)),tarEntry('dist/index.html','x'),Buffer.alloc(1024)]);bad[0]^=1;
  await assert.rejects(()=>parseMonitorThemeArchive(stream(gzipSync(bad))),/monitorTheme/);
  const valid=await installMonitorTheme(env,stream(packageBytes()));assert.equal(valid.short,'third');
});

test('native schema form filters malformed fields and preserves version-owned unknown overrides',()=>{
  const fields=monitorConfigForm([...manifest.config,{key:'enabled',type:'string',default:''},{key:'bad',type:'number',default:'bad'},{type:'title',label:'empty'}]);
  assert.equal(fields.length,6);
  const saved={enabled:false,label:123,legacy:{keep:true}};
  const values=monitorConfigValues(fields,saved);assert.equal(values.enabled,false);assert.equal(values.label,'');
  const overrides=monitorConfigOverrides(fields,saved,{...values,enabled:true,style:'b'});
  assert.deepEqual(overrides,{legacy:{keep:true},style:'b'});
  const special=[{key:'__proto__',type:'string',default:''}];
  const valuesWithSpecial=Object.fromEntries([['__proto__','original value']]);
  assert.equal(Object.hasOwn(monitorConfigOverrides(special,{},valuesWithSpecial),'__proto__'),true);
});

test('native installation needs only the existing D1 and leaves builtin-only databases unchanged',async t=>{
  const env=await fixture(t);
  assert.equal((await loadMonitorThemes(env.DB)).effective,'default');
  await selectMonitorTheme(env.DB,'serverstatus');assert.equal((await loadMonitorThemes(env.DB)).effective,'serverstatus');
  assert.equal(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='monitor_theme_chunks'").first(),null);
  const installed=await installMonitorTheme(env,stream(packageBytes()));
  assert.equal(installed.short,'third');
  assert.equal((await loadMonitorThemes(env.DB)).effective,'serverstatus');
  await assert.rejects(()=>installMonitorTheme({},stream(packageBytes())),/monitorThemeStorage/);
});

test('dynamic original dist, arbitrary SPA deep links, config GET/PUT and revision-pinned modules share viewer gates',async t=>{
  const env=await fixture(t),sys={is_public:'true',jwt_secret:'local-ecosystem-test-authority-only'};
  await env.DB.prepare("INSERT INTO settings VALUES ('site_options',?)").bind(JSON.stringify(sys)).run();
  const token=await generateToken(env,sys);
  const origin='https://native.example.test';
  const fetch=(path,options={})=>worker.fetch(new Request(origin+path,options),env);
  const first=await installMonitorTheme(env,stream(packageBytes(manifest,[tarEntry('dist/flags/US.svg','<svg/>'),tarEntry('dist/title-probe.js','nativeTitle()')])));
  await selectMonitorTheme(env.DB,'third');
  for(const path of ['/','/instance/1','/custom/detail/1']) {
    const response=await fetch(path);assert.equal(response.status,200,path);const html=await response.text();
    assert.match(html,/monitor_protocol/);assert.match(html,new RegExp(first.revision));
  }
  for(const [path,text] of [['/fonts/font.woff2','font'],['/flags/US.svg','<svg/>'],['/title-probe.js','nativeTitle()']]) {
    const response=await fetch(path);assert.equal(response.status,200,path);assert.equal(await response.text(),text);
  }
  assert.equal((await fetch('/assets/missing.js')).status,404);
  assert.equal((await fetch('/api/missing')).status,404);
  assert.equal((await fetch('/chicken/api/nodes')).status,404,'unsupported extension API is never SPA HTML');
  for(const path of ['/chicken/%61pi/nodes','/%61pi/missing','/%5fmonitor_theme/third/index.html','/%61dmin/missing','/%75pdate','/%69nstall.sh']) assert.equal((await fetch(path)).status,404,path+' remains reserved after decoding');
  assert.equal((await fetch('/api/agent/register',{method:'POST'})).status,401);
  assert.deepEqual(await fetch('/api/themes/third/config').then(r=>r.json()),{});
  assert.equal((await fetch('/api/themes/third/config',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"enabled":false}'})).status,401);
  assert.equal((await fetch('/api/themes/third/config',{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{"enabled":false}'})).status,403);
  const saved=await fetch('/api/themes/third/config',{method:'PUT',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{"enabled":false}'});
  assert.equal(saved.status,204);
  assert.deepEqual(await fetch('/api/themes/third/config').then(r=>r.json()),{enabled:false});
  const second=await installMonitorTheme(env,stream(packageBytes({...manifest,version:'2.0'},[tarEntry('dist/new.js','new')])));
  const old=await fetch(`/assets/app.js?monitor_revision=${first.revision}`);
  assert.equal(old.status,200);assert.equal(await old.text(),'export const native = true');
  const inherited=await fetch('/fonts/font.woff2',{headers:{Referer:origin+`/assets/app.js?monitor_revision=${first.revision}`}});
  assert.equal(inherited.status,307);assert.match(inherited.headers.get('Location'),new RegExp(first.revision));
  assert.notEqual(first.revision,second.revision);
  await env.DB.prepare("UPDATE settings SET value=? WHERE key='site_options'").bind(JSON.stringify({...sys,is_public:'false'})).run();
  assert.equal((await fetch('/api/themes/third/config')).status,401);
  assert.equal((await fetch('/api/themes/third/config',{headers:{Cookie:`cfsm_auth=${token}`}})).status,200);
});

test('dynamic settings backup retains install identities and deleted theme configs without importing executable pointers',async t=>{
  const env=await fixture(t);
  await installMonitorTheme(env,stream(packageBytes()),{repository:'example/native-theme'});
  await selectMonitorTheme(env.DB,'third');await saveMonitorThemeConfig(env.DB,'third',{enabled:false,legacy:'kept'});
  const backup=await exportMonitorThemes(env.DB);
  assert.equal(backup.version,2);assert.equal(backup.packages[0].repository,'example/native-theme');
  await removeMonitorTheme(env,'third');
  await importMonitorThemes(env.DB,backup);
  const state=await loadMonitorThemes(env.DB);
  assert.equal(state.selected,'third');assert.equal(state.effective,'default');assert.equal(state.configs.third.legacy,'kept');
  assert.equal(state.themes.length,2,'settings import never restores unverified asset pointers');
  await assert.rejects(()=>importMonitorThemes(env.DB,{...backup,configs:{...backup.configs,default:{show_summary:'wrong type'}}}),/monitorThemeInvalid/);
  assert.deepEqual((await loadMonitorThemes(env.DB)).configs.default,{});
});

test('builtin overrides can be removed without losing their version-owned config or breaking fallback',async t=>{
  const env=await fixture(t);
  await installMonitorTheme(env,stream(packageBytes({...manifest,short:'default'})));
  await saveMonitorThemeConfig(env.DB,'default',{enabled:false});await removeMonitorTheme(env,'default');
  assert.equal((await loadMonitorThemes(env.DB)).effective,'default');
  assert.deepEqual((await loadMonitorThemes(env.DB)).configs.default,{enabled:false});
});

test('upload verifies Origin and authority before consuming bytes; native config rejects oversized chunked input',async t=>{
  const env=await fixture(t),origin='https://native.example.test',sys={is_public:'true',jwt_secret:'ephemeral-upload-test-authority-only'};
  await env.DB.prepare("INSERT INTO settings VALUES ('site_options',?)").bind(JSON.stringify(sys)).run();
  const token=await generateToken(env,sys);
  const send=(path,headers,body)=>worker.fetch(new Request(origin+path,{method:path.includes('/upload')?'POST':'PUT',headers,body,duplex:'half'}),env);
  let consumed=false;
  const unread=new ReadableStream({pull(){consumed=true;}},{highWaterMark:0});
  assert.equal((await send('/admin/api/monitor-themes/upload',{Origin:origin},unread)).status,401);assert.equal(consumed,false);
  const uploaded=await send('/admin/api/monitor-themes/upload',{Origin:origin,Authorization:`Bearer ${token}`},stream(packageBytes()));
  assert.equal(uploaded.status,200);assert.equal((await loadMonitorThemes(env.DB)).effective,'default');
  const huge=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"note":"'+'x'.repeat(65536)+'"}'));},pull(){throw new Error('must stop reading at limit');}},{highWaterMark:0});
  assert.equal((await send('/api/themes/third/config',{Origin:origin,Authorization:`Bearer ${token}`},huge)).status,413);
  assert.deepEqual((await loadMonitorThemes(env.DB)).configs.third,{});
});

test('CF static resources stay available and admin flags do not get replaced by an installed theme',async t=>{
  const env=await fixture(t),origin='https://native.example.test';
  await env.DB.prepare("INSERT INTO settings VALUES ('site_options','{\"is_public\":\"true\"}')").run();
  env.ASSETS={fetch:async request=>new Response('CF '+new URL(request.url).pathname)};
  await installMonitorTheme(env,stream(packageBytes(manifest,[tarEntry('dist/flags/US.svg','native flag')])));await selectMonitorTheme(env.DB,'third');
  const get=(path,headers={})=>worker.fetch(new Request(origin+path,{headers}),env);
  for(const path of ['/static/admin.js','/os-icons/debian.svg','/install.sh']) assert.equal(await get(path).then(r=>r.text()),'CF '+path);
  assert.equal(await get('/flags/US.svg').then(r=>r.text()),'native flag');
  assert.equal(await get('/flags/us.svg',{Referer:origin+'/admin'}).then(r=>r.text()),'CF /flags/us.svg');
});

test('concurrent replacement refuses to overwrite a revision installed while the archive was being read',async t=>{
  const env=await fixture(t);await installMonitorTheme(env,stream(packageBytes()));
  let started,permit;const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{permit=resolve;});
  let sent=false;
  const delayed=new ReadableStream({async pull(controller){if(sent){controller.close();return;}sent=true;started();await gate;controller.enqueue(packageBytes({...manifest,version:'slow'}));}},{highWaterMark:0});
  const slow=installMonitorTheme(env,delayed);await ready;
  const latest=await installMonitorTheme(env,stream(packageBytes({...manifest,version:'fast'})));permit();
  await assert.rejects(()=>slow,/monitorThemeConflict/);
  assert.equal((await loadMonitorThemes(env.DB)).themes.find(theme=>theme.short==='third').revision,latest.revision);
});

test('GitHub install admits only a native release asset and constrained HTTPS redirects',async t=>{
  const env=await fixture(t);let location='https://release-assets.githubusercontent.com/native/theme';
  const seen=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    seen.push(String(url));assert.equal(options.headers.Authorization,undefined);
    if(String(url).includes('api.github.com')) return Response.json({tag_name:'v1.0',assets:[{name:'theme.tar.gz',size:1234}]});
    if(String(url).includes('github.com/example/')) return new Response(null,{status:302,headers:{Location:location}});
    return new Response(packageBytes());
  });
  await installMonitorRepository(env,'github.com/example/native-theme/releases?url=https://private.example/#readme');
  assert.equal(seen[0], 'https://api.github.com/repos/example/native-theme/releases/latest');
  assert.equal((await loadMonitorThemes(env.DB)).themes.find(theme=>theme.short==='third').canUpdate,true);
  location='https://private.example/theme';
  await assert.rejects(()=>installMonitorRepository(env,'https://github.com/example/native-theme'),/monitorThemeDownloadFailed/);
  assert.equal(seen.some(url=>url.includes('private.example')),false);
  for(const url of ['http://github.com/a/b','https://example.test/a/b']) assert.throws(()=>parseMonitorRepository(url),/monitorThemeRepositoryInvalid/);
});

test('pasted native GitHub links resolve only owner/repository, including bare host and Releases pages', () => {
  for (const address of [
    'https://github.com/owner/theme', ' github.com/owner/theme ',
    'https://github.com/owner/theme.git/', 'https://github.com/owner/theme/releases',
    'https://github.com/owner/theme/releases/tag/v1.0', 'https://github.com/owner/theme/tree/main',
    'https://github.com/owner/theme/blob/main/theme.json', 'https://github.com/owner/theme?tab=readme-ov-file#readme',
    'github.com/owner/theme/releases/download/v1.0/theme.tar.gz?download=1',
    'https://github.com/owner/theme?url=https://private.example/',
    'https://github.com/owner/theme/../../other/repo'
  ]) assert.equal(parseMonitorRepository(address), 'owner/theme', address);
  for (const address of [
    null, {}, '', 'https://github.com/owner', 'http://github.com/owner/theme',
    'https://github.com.evil.test/owner/theme', 'https://example.test/owner/theme',
    'https://user:pass@github.com/owner/theme', 'https://github.com:444/owner/theme',
    'https://github.com/owner/..', 'https://github.com/owner/.git',
    'https://github.com/%6fwner/theme', 'https://github.com/owner/theme%2fother',
    'https://github.com/owner\\theme'
  ]) assert.throws(() => parseMonitorRepository(address), /monitorThemeRepositoryInvalid/, String(address));
});

test('native update check skips same-version downloads and accepts builtin replacements without changing selection', async t => {
  const env = await fixture(t), origin = 'https://native.example.test';
  const sys = {is_public:'true',jwt_secret:'theme-update-fixture-authority-not-a-real-credential'};
  await env.DB.prepare('INSERT INTO settings VALUES (?,?)').bind('site_options', JSON.stringify(sys)).run();
  const token = await generateToken(env, sys);
  const initial = await installMonitorTheme(env, stream(packageBytes()));
  let tag = 'v1.0', downloads = 0, short = 'third';
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('api.github.com')) return Response.json({tag_name:tag,assets:[{name:'theme.tar.gz',size:1234}]});
    downloads++; return new Response(packageBytes({...manifest,short,version:tag.slice(1)}));
  });
  const update = theme => worker.fetch(new Request(origin+'/admin/api', {method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'update_monitor_theme',theme})}), env);
  let response = await update('third');
  assert.equal(response.status, 200); assert.equal((await response.json()).updated, false);
  assert.equal(downloads, 0); assert.equal((await loadMonitorThemes(env.DB)).themes.find(t=>t.short==='third').revision, initial.revision);
  tag='v2.0'; response=await update('third');assert.equal((await response.json()).updated,true);assert.equal(downloads,1);
  short='default'; response=await update('default');assert.equal(response.status,200);assert.equal((await response.json()).themes.find(t=>t.short==='default').builtin,false);
  assert.equal((await loadMonitorThemes(env.DB)).selected,null);
});

test('native package preview.png is catalog metadata and returned only through authenticated admin reads', async t => {
  const env=await fixture(t),origin='https://native.example.test',sys={is_public:'true',jwt_secret:'thumbnail-fixture-authority-not-a-real-credential'};
  await env.DB.prepare('INSERT INTO settings VALUES (?,?)').bind('site_options',JSON.stringify(sys)).run();
  const token=await generateToken(env,sys);
  await installMonitorTheme(env,stream(packageBytes(manifest,[tarEntry('preview.png','PNG original thumbnail')])));
  assert.equal((await loadMonitorThemes(env.DB)).themes.find(t=>t.short==='third').preview,true);
  const read = headers => worker.fetch(new Request(origin+'/admin/api',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({action:'get_monitor_theme_thumbnail',theme:'third'})}),env);
  assert.equal((await read({Origin:origin})).status,401);
  assert.equal((await read({Authorization:`Bearer ${token}`,Origin:'https://other.example'})).status,403);
  const response=await read({Authorization:`Bearer ${token}`,Origin:origin});
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal(await response.text(),'PNG original thumbnail');
});

test('failed storage/metadata completion preserves previous active version and never exposes a partial package',async t=>{
  const env=await fixture(t),first=await installMonitorTheme(env,stream(packageBytes()));
  const failingDB={prepare(query){if(query.startsWith('INSERT INTO settings(key,value) VALUES (?,?)')) return {bind(){return this;},async run(){throw new Error('write interrupted');}};return env.DB.prepare(query);}};
  await assert.rejects(()=>installMonitorTheme({...env,DB:failingDB},stream(packageBytes({...manifest,version:'2'}))),/monitorThemeUnavailable/);
  assert.equal((await loadMonitorThemes(env.DB)).themes.find(theme=>theme.short==='third').revision,first.revision);
  assert.equal((await env.DB.prepare('SELECT COUNT(DISTINCT revision) AS count FROM monitor_theme_chunks').first()).count,1);
  const brokenDB={prepare:query=>env.DB.prepare(query),async batch(){throw new Error('D1 connection interrupted');}};
  const expanded=packageBytes({...manifest,version:'large'},[tarEntry('dist/large.bin',Buffer.alloc(6*1024*1024))]);
  await assert.rejects(()=>installMonitorTheme({...env,DB:brokenDB},stream(expanded)),error=>error.code===503&&error.message==='monitorThemeUnavailable');
  assert.equal((await env.DB.prepare('SELECT COUNT(DISTINCT revision) AS count FROM monitor_theme_chunks').first()).count,1);
  let batches=0;
  const lateDB={prepare:query=>env.DB.prepare(query),async batch(statements){if(++batches===2)throw new Error('later chunk transaction interrupted');return env.DB.batch(statements);}};
  await assert.rejects(()=>installMonitorTheme({...env,DB:lateDB},stream(expanded)),/monitorThemeUnavailable/);
  assert.equal(batches,2);
  assert.equal((await env.DB.prepare('SELECT COUNT(DISTINCT revision) AS count FROM monitor_theme_chunks').first()).count,1,'committed staging chunks are cleaned after later batch failure');
});

test('native short names cannot mutate config object prototypes and each archive budget is enforced',async t=>{
  const env=await fixture(t);
  await installMonitorTheme(env,stream(packageBytes({...manifest,short:'__proto__'})));
  await saveMonitorThemeConfig(env.DB,'__proto__',{enabled:false});
  const state=await loadMonitorThemes(env.DB);
  assert.ok(Object.hasOwn(state.configs,'__proto__'));assert.equal(state.configs.__proto__.enabled,false);
  await assert.rejects(()=>parseMonitorThemeArchive(stream(new Uint8Array(33*1024*1024))),error=>error.code===413);
  await assert.rejects(()=>parseMonitorThemeArchive(stream(packageBytes(manifest,[tarEntry('dist/large.bin',Buffer.alloc(8*1024*1024+1))]))),/monitorThemeArchiveInvalid/);
});

test('GitHub installation executes through the real Workers fetch and gzip runtime',async t=>{
  const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`import {installMonitorRepository} from './src/services/monitorThemeRepository.js';export default {async fetch(request,env){try{return Response.json(await installMonitorRepository(env,'https://github.com/example/native-theme'));}catch(error){return Response.json({error:error.message},{status:error.code||500});}}};`},bundle:true,write:false,format:'esm',platform:'browser'});
  let requests=0;
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2024-12-01',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'repository-runtime'},outboundService:async request=>{
    requests++;const url=new URL(request.url);
    if(url.hostname==='api.github.com')return Response.json({tag_name:'v1',assets:[{name:'theme.tar.gz',size:1234}]});
    return new Response(packageBytes());
  }});
  t.after(()=>mf.dispose());const DB=await mf.getD1Database('DB');await DB.prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)').run();
  const response=await mf.dispatchFetch('http://localhost/install');
  assert.equal(response.status,200,await response.text());assert.equal(requests,2);
  assert.equal((await loadMonitorThemes(DB)).themes.some(theme=>theme.short==='third'),true);
});

test('a repository update cannot replace an install completed while release metadata was downloading',async t=>{
  const env=await fixture(t),first=await installMonitorTheme(env,stream(packageBytes()));let latest;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('api.github.com')) {
      latest=await installMonitorTheme(env,stream(packageBytes({...manifest,version:'newer'})));
      return Response.json({tag_name:'old',assets:[{name:'theme.tar.gz',size:1234}]});
    }
    return new Response(packageBytes());
  });
  await assert.rejects(()=>installMonitorRepository(env,'https://github.com/example/native-theme','third',first.revision),/monitorThemeConflict/);
  assert.equal((await loadMonitorThemes(env.DB)).themes.find(theme=>theme.short==='third').revision,latest.revision);
});

test('theme catalog reads manifest metadata without loading every release file index',async t=>{
  const env=await fixture(t);await installMonitorTheme(env,stream(packageBytes()));
  let query='';
  const db={prepare(sql){if(sql.includes('json_each'))query=sql;return env.DB.prepare(sql);}};
  assert.equal((await loadMonitorThemes(db)).themes.some(theme=>theme.short==='third'),true);
  assert.match(query,/json_object\(/,'catalog avoids returning all indexed archive files for every resource request');
});

test('a removed selected theme with no saved overrides still exports an importable backup',async t=>{
  const env=await fixture(t);await installMonitorTheme(env,stream(packageBytes()));await selectMonitorTheme(env.DB,'third');await removeMonitorTheme(env,'third');
  const backup=await exportMonitorThemes(env.DB);assert.equal(validMonitorThemeBackup(backup),true);
  assert.deepEqual(backup.configs.third,{});await importMonitorThemes(env.DB,backup);
  assert.equal((await loadMonitorThemes(env.DB)).selected,'third');
});

test('D1 chunks preserve arbitrary binary ranges within row and invocation budgets',async t=>{
  const env=await fixture(t),bytes=Uint8Array.from({length:8*1024*1024},(_,i)=>i%251);
  let writes=0;
  const DB={prepare:query=>env.DB.prepare(query),async batch(statements){writes++;assert.ok(statements.length<=8);return env.DB.batch(statements);}};
  const theme=await installMonitorTheme({...env,DB},stream(packageBytes(manifest,[tarEntry('dist/large.bin',bytes),tarEntry('dist/empty.bin','')])));
  assert.ok(writes<=4,'tar chunks are batched, not one query per row');
  const rows=await env.DB.prepare('SELECT part,typeof(data) AS type,length(data) AS size FROM monitor_theme_chunks WHERE revision=? ORDER BY part').bind(theme.revision).all();
  assert.ok(rows.results.length>16);
  assert.ok(rows.results.every((row,i)=>row.part===i&&row.type==='blob'&&row.size>0&&row.size<=512*1024));
  const response=await readMonitorThemeFile(env,'third','large.bin',theme.revision);
  assert.equal(response.headers.get('Content-Length'),String(bytes.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  const head=await readMonitorThemeFile(env,'third','large.bin',theme.revision,'HEAD');
  assert.equal(await head.text(),'');assert.equal(head.headers.get('Content-Length'),String(bytes.length));
  assert.equal(await (await readMonitorThemeFile(env,'third','empty.bin',theme.revision)).text(),'');
  await env.DB.prepare('DELETE FROM monitor_theme_chunks WHERE revision=? AND part=1').bind(theme.revision).run();
  await assert.rejects(()=>readMonitorThemeFile(env,'third','large.bin',theme.revision),/monitorThemeUnavailable/,'missing chunks must not become truncated success');
});

test('revision/origin-pinned cache avoids chunk reads and always recovers from D1 on eviction or cache failure',async t=>{
  const env=await fixture(t),first=await installMonitorTheme(env,stream(packageBytes()));
  const entries=new Map(),keys=[];let broken=false,reads=0;
  const previous=globalThis.caches;
  globalThis.caches={default:{async match(key){if(broken)throw new Error('cache unavailable');return entries.get(key.url)?.clone();},async put(key,response){keys.push(key.url);if(broken)throw new Error('cache unavailable');entries.set(key.url,new Response(await response.arrayBuffer(),{headers:response.headers}));}}};
  t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
  const DB={prepare(query){if(query.includes('monitor_theme_chunks'))reads++;return env.DB.prepare(query);}};
  const get=origin=>readMonitorThemeFile({...env,DB},'third','assets/app.js',first.revision,'GET','',origin);
  assert.equal(await (await get('https://native.example.test')).text(),'export const native = true');
  const before=reads;assert.ok(before>0);
  assert.equal(await (await get('https://native.example.test')).text(),'export const native = true');assert.equal(reads,before);
  assert.ok(keys[0].startsWith('https://native.example.test/'));assert.ok(keys[0].includes(first.revision));
  await get('https://another.example.test');assert.ok(reads>before,'origins cannot share cache authority');
  entries.clear();await removeMonitorTheme(env,'third');
  assert.equal(await (await get('https://native.example.test')).text(),'export const native = true','evicted old revision survives removal without its remote origin');
  broken=true;assert.equal(await (await get('https://native.example.test')).text(),'export const native = true');
});

test('small theme files read only their own byte slices, not complete shared archive chunks',async t=>{
  const env=await fixture(t),theme=await installMonitorTheme(env,stream(packageBytes()));
  let returned=0;
  const DB={prepare(query){const statement=env.DB.prepare(query);if(query.includes('hex('))return {bind(...values){const bound=statement.bind(...values);return {async all(){const result=await bound.all();returned=result.results.reduce((total,row)=>total+row.bytes.length/2,0);return result;}};}};return statement;}};
  assert.equal(await (await readMonitorThemeFile({...env,DB},'third','fonts/font.woff2',theme.revision)).text(),'font');
  assert.equal(returned,4,'cold tiny-file requests must not transfer512KiB from D1');
});

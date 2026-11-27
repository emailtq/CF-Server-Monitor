import { monitorBuiltinRevision } from "../shared/monitorThemes.js";
import { checkAuth, getTerminalJwtPrincipal } from '../middleware/auth.js';
import { loadMonitorViewerPolicy, authorizeMonitorViewer, loadMonitorViewerAccess } from '../services/monitorViewerAccess.js';
import { loadMonitorThemes, getMonitorThemeConfig, saveMonitorThemeConfig, prepareMonitorThemeSelection } from '../services/monitorThemes.js';
import { loadMonitorPackageRegistry, loadMonitorRelease, readMonitorThemeThumbnail, removeMonitorTheme } from '../services/monitorThemePackages.js';
import { installMonitorRepository } from '../services/monitorThemeRepository.js';
import { receiveMonitorThemeChunk } from '../services/monitorThemeChunks.js';
import { decodeMonitorSiteIcon } from '../services/monitorSiteIcons.js';
import { loadSiteSettings, loadAppearanceOptions, clearSiteSettingsCache, clearAppearanceSettingsCache } from '../utils/settings.js';
import { handlePrepareRegistration, handleCloseRegistration } from './agentRegistration.js';
import { AppError } from '../utils/errors.js';
import { resolveMonitorPreview } from './monitorThemePreview.js';

const headers={'Cache-Control':'no-store'};
export const monitorRestFailure=(text,status,extra={})=>new Response(text,{status,headers:{...headers,'Content-Type':'text/plain; charset=utf-8',...extra}});
export async function monitorRestAdmin(request,env) {
  const url=new URL(request.url);
  if (!['GET','HEAD'].includes(request.method) && (url.protocol!=='https:' || request.headers.get('Origin')!==url.origin || ['same-site','cross-site','none'].includes(request.headers.get('Sec-Fetch-Site')))) throw new AppError('Forbidden',403);
  const policy=await loadMonitorViewerPolicy(env);
  if(policy.status===503)throw new AppError('Service Unavailable',503);
  if(!await checkAuth(request,env,policy))throw new AppError('Unauthorized',401);
  const access=await authorizeMonitorViewer(request,env,policy);
  if(!access.authed)throw new AppError('Unauthorized',401);
  if(access.status!==200)throw new AppError('Forbidden',access.status);
  return {policy,owner:await getTerminalJwtPrincipal(request,env,policy)};
}
export async function readMonitorRestJson(request, {allowUntyped=false,exactAllowance=false}={}) {
  if(!(allowUntyped&&!request.headers.has('Content-Type'))&&!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('Content-Type')||''))throw new AppError('JSON required',415);
  const reader=request.body?.getReader();if(!reader)throw new AppError('Invalid JSON',400);
  let size=0;const chunks=[];
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new AppError('Payload Too Large',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes),(key,value,context)=>exactAllowance&&key==='traffic_limit'&&typeof value==='number'&&/^\d+$/.test(context.source)?BigInt(context.source):value);if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return body;}
  catch{throw new AppError('Invalid JSON',400);}
}
async function settings(env) {
  clearAppearanceSettingsCache();
  const [site,appearance,state]=await Promise.all([loadSiteSettings(env.DB),loadAppearanceOptions(env.DB),loadMonitorThemes(env.DB,env.MONITOR_COMPAT_THEME)]);
  return {site_name:appearance.site_title||'',public_page:site.is_public==='true'?'on':'off',theme:state.selected||env.MONITOR_COMPAT_THEME||'default',
    favicon:appearance.favicon||'',touch_icon:appearance.touch_icon||'',retention_days:'30',
    show_price:site.show_price,show_expire:site.show_expire,show_tf:site.show_tf,auto_discovery:site.auto_discovery,
    turnstile_enabled:site.turnstile_enabled,turnstile_login_enabled:site.turnstile_login_enabled,turnstile_site_key:site.turnstile_site_key||''};
}
async function saveSettings(env,body,policy) {
  const site={},appearance={};
  for(const [key,value] of Object.entries(body)) {
    if(typeof value!=='string')throw new AppError(`Setting ${key} must be a string`,400);
    if(key==='theme') {if(!(await loadMonitorThemes(env.DB)).themes.some(t=>t.short===value))throw new AppError('monitorThemeInvalid',400);}
    else if(key==='site_name'){if(value.length>200||/[\x00-\x1f]/.test(value))throw new AppError('Invalid site name',400);appearance.site_title=value;}
    else if(key==='favicon'||key==='touch_icon'){if(value)decodeMonitorSiteIcon(value);appearance[key]=value;}
    else if(key==='public_page'){if(!['on','off'].includes(value))throw new AppError('Invalid public_page',400);site.is_public=value==='on'?'true':'false';}
    else if(['show_price','show_expire','show_tf','auto_discovery','turnstile_enabled','turnstile_login_enabled'].includes(key)){if(!['true','false'].includes(value))throw new AppError(`Invalid ${key}`,400);site[key]=value;}
    else if(['turnstile_site_key','turnstile_secret_key'].includes(key)){if(value.length>4096)throw new AppError('Invalid Turnstile key',400);site[key]=value;}
    else throw new AppError(`Unsupported setting: ${key}`,key==='retention_days'||key==='github_proxy'?422:400);
  }
  const rows=await env.DB.prepare("SELECT key,value FROM settings WHERE key IN('site_options','appearance_options')").all();
  const stored=Object.fromEntries(rows.results.map(row=>[row.key,JSON.parse(row.value)]));
  const previous=stored.site_options;
  if(!previous||previous.jwt_secret!==policy.jwt_secret)throw new AppError('Unauthorized',401);
  if(['turnstile_enabled','turnstile_login_enabled'].some(k=>(site[k]??previous[k])==='true') && (!String(site.turnstile_site_key??previous.turnstile_site_key??'').trim()||!String(site.turnstile_secret_key??previous.turnstile_secret_key??'').trim()))throw new AppError('Turnstile keys required',400);
  const statements=[],expected=[];
  for(const [key,updates] of [['site_options',site],['appearance_options',appearance]])if(Object.keys(updates).length) {
    const before=rows.results.find(row=>row.key===key)?.value;
    const value=JSON.stringify({...stored[key],...updates});
    expected.push([key,value]);
    statements.push(before===undefined?env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind(key,value):
      env.DB.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').bind(value,key,before));
  }
  if(Object.hasOwn(body,'theme')){
    const value=JSON.stringify(body.theme);expected.push(['monitor_theme_selection',value]);
    statements.push(await prepareMonitorThemeSelection(env.DB,body.theme));
  }
  if(!statements.length)return;
  // The final assertion aborts the whole transaction on a lost grouped-settings CAS.
  statements.push(env.DB.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) wanted
    WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key=json_extract(wanted.value,'$[0]') AND value=json_extract(wanted.value,'$[1]'))) THEN '{}' ELSE '' END)`).bind(JSON.stringify(expected)));
  await env.DB.batch(statements);
  clearSiteSettingsCache();clearAppearanceSettingsCache();
}
export async function handleMonitorThemeRest(request,env,url) {
  const match=/^\/api\/themes\/([A-Za-z0-9_-]{1,128})(?:\/(config|preview|update))?$/.exec(url.pathname);
  if(!match&&!['/api/themes','/api/settings','/api/theme-install','/api/register-window'].includes(url.pathname))return null;
  if(match?.[2]==='config'&&env.MONITOR_FRONTEND_MODE==='legacy')return null;
  const readConfig=match?.[2]==='config'&&request.method==='GET';
  const allowed=match?(match[2]==='config'?['GET','PUT']:match[2]==='preview'?['GET']:match[2]==='update'?['POST']:['DELETE']):
    url.pathname==='/api/themes'?['GET','POST']:url.pathname==='/api/settings'?['GET','PUT']:url.pathname==='/api/register-window'?['POST','DELETE']:['POST'];
  if(!allowed.includes(request.method))return monitorRestFailure('Method Not Allowed',405,{Allow:allowed.join(', ')});
  try {
    const preview=await resolveMonitorPreview(request,env,url);
    if(preview?.status)throw new AppError(preview.error,preview.status);
    const {owner,policy}=readConfig?{}:await monitorRestAdmin(request,env);
    if(readConfig){const access=await loadMonitorViewerAccess(request,env);if(access.status!==200)throw new AppError('Unauthorized',access.status);return Response.json(await getMonitorThemeConfig(env.DB,match[1]),{headers});}
    if(url.pathname==='/api/themes'){
      if(request.method==='GET'){const state=await loadMonitorThemes(env.DB,env.MONITOR_COMPAT_THEME);return Response.json({themes:state.themes.map(t=>({...t,selected:t.short===state.effective}))},{headers});}
      if(!/^application\/octet-stream(?:\s*;.*)?$/i.test(request.headers.get('Content-Type')||''))throw new AppError('Octet stream required',415);
      if(!/^\d+$/.test(url.searchParams.get('offset')||'')||!/^\d+$/.test(url.searchParams.get('total')||'')||url.searchParams.getAll('offset').length!==1||url.searchParams.getAll('total').length!==1)throw new AppError('Invalid chunk query',400);
      return Response.json(await receiveMonitorThemeChunk(request,env,{...owner,authority:policy.jwt_secret},{offset:Number(url.searchParams.get('offset')),total:Number(url.searchParams.get('total'))}),{headers});
    }
    if(url.pathname==='/api/settings'){if(request.method==='GET')return Response.json(await settings(env),{headers});await saveSettings(env,await readMonitorRestJson(request),policy);return Response.json({ok:true},{headers});}
    if(url.pathname==='/api/register-window'){
      const response=request.method==='POST'?await handlePrepareRegistration(request,env,{action:'node_prepare_registration'}):await handleCloseRegistration(request,env);
      const body=await response.json();if(response.status!==200)throw new AppError(body.error,response.status);
      return request.method==='DELETE'?new Response(null,{status:204,headers}):Response.json({register_key:body.key,register_left:Math.max(0,Math.floor((body.expiresAt-Date.now())/1000))},{headers});
    }
    if(url.pathname==='/api/theme-install'){const body=await readMonitorRestJson(request);if(typeof body.url!=='string'||Object.keys(body).some(k=>k!=='url'))throw new AppError('Invalid repository',400);const theme=await installMonitorRepository(env,body.url,undefined,undefined,undefined,{...owner,authority:policy.jwt_secret});return Response.json({theme},{headers});}
    const short=match[1];
    if(match[2]==='config'){await saveMonitorThemeConfig(env.DB,short,await readMonitorRestJson(request,{allowUntyped:true}));return new Response(null,{status:204,headers});}
    if(match[2]==='preview'){const image=await readMonitorThemeThumbnail(env,short);return image?new Response(image.body,{headers:{...headers,'Content-Type':'image/png'}}):new Response(null,{status:404,headers});}
    if(match[2]==='update'){
      const {registry}=await loadMonitorPackageRegistry(env.DB),revision=registry[short]??null;
      const release=await loadMonitorRelease(env.DB,revision||monitorBuiltinRevision(short));if(!release)throw new AppError('monitorThemeInvalid',400);
      const result=await installMonitorRepository(env,release.repository?`https://github.com/${release.repository}`:release.manifest.url,short,revision,release.manifest.version,{...owner,authority:policy.jwt_secret});
      return Response.json({updated:result.updated,version:result.version},{headers});
    }
    await removeMonitorTheme(env,short);return new Response(null,{status:204,headers});
  }catch(error){return monitorRestFailure(error instanceof AppError?error.message:'Service Unavailable',error instanceof AppError?error.code:503);}
}

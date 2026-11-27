import { executeAdminAction, testNotificationChannel, handleLogoutAction } from './admin.js';
import { monitorRestAdmin, monitorRestFailure, readMonitorRestJson } from './monitorThemeRest.js';
import { getMonitorCompatIds } from '../database/monitorCompatIds.js';
import { getMonitorProbeIds } from '../database/monitorProbeIds.js';
import { changeLatencyTasks } from '../database/latencyTasks.js';
import { loadSiteSettings } from '../utils/settings.js';
import { clearAllCaches } from '../utils/cache.js';
import { clearDashboardLatencyHistoryCache } from '../database/schema.js';
import { scheduleLatencyTasksChanged } from '../utils/agentConfigNotify.js';
import { loadNotificationConfig } from '../database/notifications.js';
import { AppError } from '../utils/errors.js';

const headers={'Cache-Control':'no-store'};
const bad=text=>{throw new AppError(text,400);};
const allowedKeys=(body,keys)=>{if(Object.keys(body).some(k=>!keys.includes(k)))bad('Unsupported fields');};
async function business(context,data) {
  const response=await executeAdminAction({...context,data});
  const result=await response.json();
  if(!response.ok)throw new AppError(result.error||result.message||'Operation failed',response.status);
  return result;
}
async function nodeMap(db) {
  const {results}=await db.prepare('SELECT * FROM servers ORDER BY sort_order,id').all();
  const ids=await getMonitorCompatIds(db,results.map(n=>n.id));
  return new Map(results.map(n=>[ids.get(n.id),n]));
}
function ids(input,map) {
  if(!Array.isArray(input)||new Set(input).size!==input.length||input.some(id=>!Number.isSafeInteger(id)||!map.has(id)))bad('Invalid IDs');
  return input.map(id=>map.get(id).id);
}
const NODE_FIELDS=['name','public','price','currency','billing_cycle','expires_at','remark','public_remark','traffic_limit','traffic_mode','traffic_reset_day','notify','country_pin','ipv4_pin','ipv6_pin','group'];
function nodePatch(body) {
  allowedKeys(body,NODE_FIELDS);const patch={};
  const fields={name:'name',public:'is_hidden',price:'price',currency:'currency',billing_cycle:'billing_cycle',expires_at:'expire_date',remark:'note',public_remark:'public_remark',traffic_limit:'traffic_limit',traffic_mode:'traffic_calc_type',traffic_reset_day:'reset_day',notify:'offline_notify_disabled',country_pin:'region',group:'server_group'};
  for(const [key,value] of Object.entries(body)) {
    if(key==='ipv4_pin'||key==='ipv6_pin')throw new AppError('CF has no persistent address-pin setting',422);
    if(['public','notify'].includes(key)){if(typeof value!=='boolean')bad('Boolean required');patch[fields[key]]=value?'0':'1';}
    else if(key==='price'){if(typeof value!=='number'||!Number.isFinite(value)||value<0)bad('Invalid price');patch.price=value;}
    else if(key==='traffic_limit'){
      if(typeof value!=='bigint'||value<0n||value>9223372036854775807n)bad('Invalid traffic limit');
      const decimal=(value*5n**30n).toString().padStart(31,'0');
      patch.traffic_limit=decimal.slice(0,-30)+'.'+decimal.slice(-30);
    }
    else if(key==='traffic_reset_day'){if(!Number.isInteger(value)||value<1||value>31)bad('Invalid reset day');patch.reset_day=value;}
    else if(key==='traffic_mode'){if(!['sum','max','up','down'].includes(value))bad('Invalid traffic mode');patch.traffic_calc_type={sum:'total',max:'max',up:'ul',down:'dl'}[value];}
    else if(key==='expires_at'){if(value!==null&&(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))bad('Invalid expiry');patch.expire_date=value??'';}
    else {
      if(typeof value!=='string'||value.length>(key==='name'?100:['remark','public_remark'].includes(key)?500:128)||/[\x00-\x1f]/.test(value))bad('Invalid text');
      if(key==='name'&&!value.trim())bad('Name required');
      if(key==='country_pin'&&value!==''&&!/^[A-Z]{2}$/.test(value))bad('Invalid country');
      if(key==='currency'&&!/^[A-Z]{3}$/.test(value))bad('Invalid currency');
      if(key==='billing_cycle'){
        const cycles={monthly:'month',quarterly:'quarter',semiannual:'half_year',yearly:'year',biennial:'two_years',triennial:'three_years','48m':'four_years','60m':'five_years'};
        if(!Object.hasOwn(cycles,value))bad('Unsupported billing cycle');patch.billing_cycle=cycles[value];continue;
      }
      patch[fields[key]]=value;
    }
  }
  return patch;
}
async function catalog(context) {
  const document=await changeLatencyTasks(context.env.DB,context.sys,'reconcile');
  context.sys.latency_tasks=document;
  const numeric=await getMonitorProbeIds(context.env.DB,document.tasks.map(task=>task.metric_id||task.id));
  return {document,map:new Map(document.tasks.map(task=>[numeric.get(task.metric_id||task.id),task]))};
}
export async function handleMonitorAdminRest(request,env,url,ctx) {
  const node=/^\/api\/nodes\/([1-9]\d*)(?:\/(token|traffic|ping-tasks))?$/.exec(url.pathname);
  const task=/^\/api\/ping-tasks\/([1-9]\d*)$/.exec(url.pathname);
  const unsupported=['/api/version','/api/sessions','/api/db','/api/db/backup','/api/db/restore','/api/db/vacuum','/api/agent/echo','/api/auth/login','/api/auth/github','/api/auth/github/callback'];
  if(url.pathname==='/api/auth/logout') {
    if(request.method!=='POST')return monitorRestFailure('Method Not Allowed',405,{Allow:'POST'});
    if(request.headers.get('Origin')!==url.origin)return monitorRestFailure('Forbidden',403);
    const response=await handleLogoutAction({request,env,sys:await loadSiteSettings(env.DB)});
    if(!response.ok)return monitorRestFailure('Logout revocation failed',response.status);
    const finalHeaders=new Headers(response.headers);finalHeaders.set('Cache-Control','no-store');
    return new Response(JSON.stringify({ok:true}),{headers:finalHeaders});
  }
  if(!node&&!task&&!['/api/nodes/order','/api/nodes/batch','/api/ping-tasks','/api/ping-tasks/order','/api/notify/test',...unsupported].includes(url.pathname)&&!(url.pathname==='/api/nodes'&&request.method==='POST')&&!/^\/api\/sessions\//.test(url.pathname))return null;
  const methods=node?(node[2]==='token'?['GET','POST']:node[2]?['PUT']:['PUT','DELETE']):task?['DELETE']:url.pathname==='/api/ping-tasks'?['GET','POST']:url.pathname==='/api/nodes'||url.pathname==='/api/notify/test'?['POST']:['PUT'];
  try {
    await monitorRestAdmin(request,env);
    if(unsupported.includes(url.pathname)||/^\/api\/sessions\//.test(url.pathname)||node?.[2]==='traffic')throw new AppError('Unsupported on CF; use the existing platform capability',501);
    if(!methods.includes(request.method))return monitorRestFailure('Method Not Allowed',405,{Allow:methods.join(', ')});
    const context={request,env,ctx,sys:await loadSiteSettings(env.DB,{forceRefresh:true})},nodes=await nodeMap(env.DB);
    const body=['PUT','POST'].includes(request.method)&&!['/api/notify/test'].includes(url.pathname)&&node?.[2]!=='token'?await readMonitorRestJson(request,{exactAllowance:true}):{};
    if(url.pathname==='/api/nodes'){
      const patch={currency:'USD',billing_cycle:'month',server_group:'',is_hidden:'0',offline_notify_disabled:'1',...nodePatch(body)};
      const created=await business({...context,nativePatch:patch},{action:'add',name:patch.name||'New Server',server_group:patch.server_group||'',region:patch.region});
      const id=(await getMonitorCompatIds(env.DB,[created.id])).get(created.id);return Response.json({id},{headers});
    }
    if(node){
      const current=nodes.get(Number(node[1]));if(!current)throw new AppError('Node not found',404);
      if(node[2]==='token'){const result=await business(context,{action:request.method==='GET'?'node_read_install':'node_reset_token',serverId:current.id});return Response.json({token:result.token},{headers});}
      if(!node[2]&&request.method==='DELETE'){await business(context,{action:'delete',id:current.id});return Response.json({ok:true},{headers});}
      if(!node[2]){const patch=nodePatch(body);await business({...context,nativePatch:patch},{...current,...patch,action:'edit'});return Response.json({ok:true},{headers});}
    }
    if(url.pathname==='/api/nodes/order'){
      allowedKeys(body,['ids']);const order=ids(body.ids,nodes);if(order.length!==nodes.size)bad('Complete node order required');
      if(!order.length) {
        try {await env.DB.prepare("SELECT json(CASE WHEN (SELECT COUNT(*) FROM servers)=0 THEN '{}' ELSE '' END)").first();}
        catch {bad('Complete node order required');}
      } else await business({...context,nativePatch:{publicId:body.ids[0]}},{action:'save_order',orders:order});
      return Response.json({ok:true},{headers});
    }
    if(url.pathname==='/api/nodes/batch'){
      allowedKeys(body,['ids','patch']);if(!Array.isArray(body.ids))bad('IDs required');const unique=[...new Set(body.ids)];
      if(unique.some(id=>Number.isSafeInteger(id)&&!nodes.has(id)))throw new AppError('Node not found; no changes',404);
      const selected=ids(unique,nodes);if(!selected.length)bad('IDs required');const patch=nodePatch(body.patch||{});
      if(Object.keys(patch).some(k=>!['server_group','offline_notify_disabled'].includes(k)))bad('Batch only supports group and notify');
      await business(context,{action:'batch_metadata',ids:selected,patch});return Response.json({updated:selected.length},{headers});
    }
    if(url.pathname==='/api/notify/test'){
      const config=await loadNotificationConfig(env.DB),channels=config.channels.filter(c=>c.enabled);
      if(!channels.length)bad('No notification channels enabled');const sent=[];
      for(const channel of channels){try {await testNotificationChannel(env.DB,{...channel});}catch(error){throw new AppError('Notification delivery failed',error.status||503);}sent.push(channel.name);}
      return Response.json({sent},{headers});
    }
    // Reject incompatible first writes before even creating/reconciling a catalog.
    if(url.pathname==='/api/ping-tasks'&&request.method==='POST') {
      const scope=body.auto_join?[...nodes.keys()]:body.nodes;
      if(Array.isArray(scope)&&scope.some(id=>nodes.get(id)?.ping_mode==='icmp'))throw new AppError('monitor_icmp_tasks_unavailable',422);
    }
    if(node?.[2]==='ping-tasks'&&nodes.get(Number(node[1])).ping_mode==='icmp'&&Array.isArray(body.tasks)&&body.tasks.length)throw new AppError('monitor_icmp_tasks_unavailable',422);
    const {document,map}=await catalog(context);
    if(url.pathname==='/api/ping-tasks'&&request.method==='GET')return Response.json({tasks:[...map].map(([id,t])=>{
      const scope=[...nodes.values()].filter(n=>t.auto_join||t.nodes.includes(n.id)),icmp=scope.filter(n=>n.ping_mode==='icmp').length;
      const mode=icmp?(icmp===scope.length?'icmp':'mixed'):'tcp';
      return {id,name:t.name,target:t.target,interval:t.interval,nodes:[...nodes].filter(([,n])=>t.nodes.includes(n.id)).map(([id])=>id),auto_join:t.auto_join,
        mode,standard_supported:!icmp,...(icmp?{unsupported:'monitor_icmp_tasks_unavailable'}:{})};
    })},{headers});
    let action,input;
    if(node?.[2]==='ping-tasks'){allowedKeys(body,['tasks','base']);action='node';input={node:nodes.get(Number(node[1])).id,tasks:ids(body.tasks,map),base:ids(body.base,map)};}
    else if(task){const found=map.get(Number(task[1]));if(!found)throw new AppError('Probe not found',404);action='delete';input={id:found.id};}
    else if(url.pathname==='/api/ping-tasks/order'){allowedKeys(body,['ids']);action='order';input={ids:ids(body.ids,map)};if(input.ids.length!==map.size)bad('Complete probe order required');}
    else {
      allowedKeys(body,['id','name','target','interval','nodes','auto_join','base']);const current=body.id?map.get(body.id):null;if(body.id&&!current)throw new AppError('Probe not found',404);
      if(typeof body.target!=='string'||!/(?:\]|[^:]):\d+$/.test(body.target))bad('Standard probe requires TCP host:port');
      action='save';input={...body,nodes:ids(body.nodes,nodes),...(current?{id:current.id,base:ids(body.base,nodes)}:{})};delete input.id;if(current)input.id=current.id;
    }
    const next=await changeLatencyTasks(env.DB,context.sys,action,input,{standardTcp:['save','node'].includes(action)});clearAllCaches();clearDashboardLatencyHistoryCache();scheduleLatencyTasksChanged(env,ctx);
    if(action==='save'){const saved=next.tasks.find(t=>input.id?t.id===input.id:!document.tasks.some(old=>old.id===t.id));return Response.json({id:(await getMonitorProbeIds(env.DB,[saved.metric_id||saved.id])).get(saved.metric_id||saved.id)},{headers});}
    return Response.json({ok:true},{headers});
  }catch(error){return monitorRestFailure(error instanceof AppError?error.message:'Service Unavailable',error instanceof AppError?error.code:503);}
}

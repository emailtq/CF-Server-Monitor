import { AppError } from '../utils/errors.js';

const ICONS = new Map([['/favicon.svg','favicon'],['/favicon.ico','favicon'],['/apple-touch-icon.png','touch_icon'],['/apple-touch-icon-precomposed.png','touch_icon']]);
export function decodeMonitorSiteIcon(value) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match || match[1].length>27308) throw new AppError('monitorSiteIconInvalid',400);
  let data;
  try {data=Uint8Array.from(atob(match[1]),c=>c.charCodeAt(0));} catch {throw new AppError('monitorSiteIconInvalid',400);}
  if (!data.length || data.length>20480) throw new AppError('monitorSiteIconInvalid',400);
  const starts = bytes=>bytes.every((b,i)=>data[i]===b);
  const mime = starts([137,80,78,71])?'image/png':starts([0,0,1,0])?'image/x-icon':starts([255,216,255])?'image/jpeg':
    starts([71,73,70,56])?'image/gif':starts([82,73,70,70])&&[87,69,66,80].every((b,i)=>data[i+8]===b)?'image/webp':
      new TextDecoder().decode(data).includes('<svg')?'image/svg+xml':null;
  if (!mime) throw new AppError('monitorSiteIconInvalid',400);
  return {data,mime};
}
export async function serveMonitorSiteIcon(request,env,url) {
  const key=ICONS.get(url.pathname);
  if (!key || !['GET','HEAD'].includes(request.method) || url.search==='?theme') return null;
  const row=await env.DB.prepare("SELECT json_extract(value,?) AS value FROM settings WHERE key='appearance_options'").bind(`$.${key}`).first();
  if (!row?.value || !row.value.startsWith('data:image/')) return null;
  const {data,mime}=decodeMonitorSiteIcon(row.value);
  return new Response(request.method==='HEAD'?null:data,{headers:{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"}});
}

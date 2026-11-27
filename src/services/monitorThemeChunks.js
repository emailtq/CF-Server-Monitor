import { AppError } from '../utils/errors.js';
import { MONITOR_ARCHIVE_LIMIT } from '../shared/monitorThemeArchive.js';
import { installMonitorTheme, loadMonitorPackageRegistry, assertMonitorThemePublisher } from './monitorThemePackages.js';

const MAX_CHUNK = 8 * 1024 * 1024;
const PART = 512 * 1024;
const invalid = () => new AppError('monitorThemeChunkInvalid', 400);
const unavailable = () => new AppError('monitorThemeUnavailable', 503);

export async function receiveMonitorThemeChunk(request, env, owner, {offset,total}) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset < 0 || total < 1 || offset >= total) throw invalid();
  if (total > MONITOR_ARCHIVE_LIMIT) throw new AppError('monitorThemeArchiveTooLarge',413);
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CHUNK)) throw new AppError('monitorThemeChunkTooLarge',413);
  if (!owner?.jti) throw new AppError('Unauthorized',401);
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_theme_uploads (
      owner TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, total INTEGER NOT NULL,
      received INTEGER NOT NULL, parts INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      registry TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'receiving')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_theme_upload_chunks (
      upload_id TEXT NOT NULL REFERENCES monitor_theme_uploads(id) ON DELETE CASCADE,
      part INTEGER NOT NULL, data BLOB NOT NULL CHECK(length(data)>0 AND length(data)<=${PART}),
      PRIMARY KEY(upload_id,part)) WITHOUT ROWID`)
  ]);
  await db.prepare('DELETE FROM monitor_theme_uploads WHERE owner IN (SELECT owner FROM monitor_theme_uploads WHERE expires_at < ? LIMIT 10)').bind(Date.now()).run();
  let session = await db.prepare('SELECT * FROM monitor_theme_uploads WHERE owner=?').bind(owner.jti).first();
  if (offset === 0) {
    await assertMonitorThemePublisher(db,owner);
    const {registry} = await loadMonitorPackageRegistry(db), id = crypto.randomUUID();
    const created = session
      ? (await db.batch([
        db.prepare("DELETE FROM monitor_theme_upload_chunks WHERE upload_id=? AND EXISTS(SELECT 1 FROM monitor_theme_uploads WHERE owner=? AND id=? AND state='receiving')").bind(session.id,owner.jti,session.id),
        db.prepare("UPDATE monitor_theme_uploads SET id=?,total=?,received=0,parts=0,expires_at=?,registry=?,state='receiving' WHERE owner=? AND id=? AND state='receiving'")
          .bind(id,total,Date.now()+900000,JSON.stringify(registry),owner.jti,session.id)
      ])).at(-1)
      : await db.prepare("INSERT INTO monitor_theme_uploads(owner,id,total,received,parts,expires_at,registry) SELECT ?,?,?,0,0,?,? WHERE (SELECT COUNT(*) FROM monitor_theme_uploads)<128 ON CONFLICT(owner) DO NOTHING")
        .bind(owner.jti,id,total,Date.now()+900000,JSON.stringify(registry)).run();
    if (created.meta?.changes !== 1) throw new AppError('monitorThemeConflict',409);
    session = {id,total,received:0,parts:0,registry:JSON.stringify(registry),state:'receiving'};
  }
  if (!session || session.state !== 'receiving' || session.received !== offset || session.total !== total) throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_CHUNK || offset+size > total) {await reader.cancel();throw new AppError('monitorThemeChunkTooLarge',size>MAX_CHUNK?413:400);}
      chunks.push(value);
    }
  } catch (error) {throw error instanceof AppError?error:invalid();}
  finally {reader.releaseLock();}
  if (!size || (length !== null && size !== Number(length))) throw invalid();
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) {bytes.set(chunk,at);at+=chunk.byteLength;}
  const count = Math.ceil(size/PART), received = offset+size;
  if(session.parts+count>128)throw new AppError('monitorThemeChunkLimit',413);
  const guard = "owner=? AND id=? AND received=? AND total=? AND state='receiving' AND expires_at>?";
  const args = [owner.jti,session.id,offset,total,Date.now()];
  // All piece bytes and the continuous-offset pointer land in the same D1 transaction.
  // A duplicate part is a constraint failure, rolling back a competing append.
  try {
    const statements = [];
    for (let i=0;i<count;i++) statements.push(db.prepare(`INSERT INTO monitor_theme_upload_chunks(upload_id,part,data)
      VALUES (?,?,CASE WHEN EXISTS(SELECT 1 FROM monitor_theme_uploads WHERE ${guard}) THEN ? ELSE NULL END)`)
      .bind(session.id,session.parts+i,...args,bytes.slice(i*PART,(i+1)*PART).buffer));
    statements.push(db.prepare(`UPDATE monitor_theme_uploads SET received=?,parts=?,state=? WHERE ${guard}`)
      .bind(received,session.parts+count,received===total?'installing':'receiving',...args));
    const results = await db.batch(statements);
    if (results.at(-1).meta?.changes !== 1) throw new AppError('monitorThemeConflict',409);
  } catch (error) {
    const current = await db.prepare('SELECT id,received,state FROM monitor_theme_uploads WHERE owner=?').bind(owner.jti).first();
    if (!current || current.id!==session.id || current.received!==offset || current.state!=='receiving') throw new AppError('monitorThemeConflict',409);
    throw error instanceof AppError?error:unavailable();
  }
  if (received < total) return {received};
  let part = 0;
  const source = new ReadableStream({async pull(controller) {
    try {
      if (part===session.parts+count) {controller.close();return;}
      const row = await db.prepare('SELECT data FROM monitor_theme_upload_chunks WHERE upload_id=? AND part=?').bind(session.id,part++).first();
      if (!row) throw unavailable();controller.enqueue(new Uint8Array(row.data));
    } catch(error) {controller.error(error);}
  }});
  try {
    await assertMonitorThemePublisher(db,owner);
    const theme = await installMonitorTheme(env,source,{initialRegistry:JSON.parse(session.registry),publisher:owner});
    return {theme};
  } finally {
    // Only temporary compressed uploads are collected; published/pinned archives are independent.
    await db.prepare('DELETE FROM monitor_theme_uploads WHERE owner=? AND id=?').bind(owner.jti,session.id).run().catch(()=>{});
  }
}

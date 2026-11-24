import { parseAgentRpc, MONITOR_AGENT_LIMITS } from './monitorAgentProtocol.js';

export const MONITOR_BUCKET_BYTES = 262144;
export const MONITOR_STATE_BYTES = 1048576;
export const MONITOR_BUCKET_MS = 300000;
export const monitorBytes = value => new TextEncoder().encode(value);
export const isValidMonitorPrincipal = p => p && typeof p.serverId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(p.serverId) && Number.isSafeInteger(p.tokenVersion) && p.tokenVersion > 0;
const batchCapability = [{method:'cf.report.batch',version:1}];

export class MonitorTelemetryError extends Error {
  constructor(code,message,expectedSequence) {
    super(message);
    this.name = 'MonitorTelemetryError';
    this.code = code;
    if (expectedSequence !== undefined) this.expectedSequence = expectedSequence;
  }
}

/** The envelope ID can change, but the actual params text (not a reserialization) cannot. */
export function parseMonitorBatch(raw) {
  const rpc = parseAgentRpc(raw,{implemented:batchCapability,negotiated:batchCapability});
  if (rpc.method !== 'cf.report.batch') throw new MonitorTelemetryError('monitor_invalid_batch','Invalid batch method');
  let pos = 0;
  const whitespace = () => { while (/\s/.test(raw[pos] || '') && pos < raw.length) pos++; };
  const stringEnd = () => {
    pos++;
    while (pos < raw.length) {
      if (raw[pos] === '\\') pos += 2;
      else if (raw[pos++] === '"') break;
    }
  };
  const valueEnd = () => {
    if (raw[pos] === '"') {stringEnd();return;}
    if (raw[pos] === '{' || raw[pos] === '[') {
      let depth = 0;
      do {
        if (raw[pos] === '"') stringEnd();
        else { if ('{['.includes(raw[pos])) depth++; if ('}]'.includes(raw[pos])) depth--; pos++; }
      } while (depth > 0 && pos < raw.length);
    } else while (pos < raw.length && !/[,}\s]/.test(raw[pos])) pos++;
  };
  whitespace(); pos++; whitespace();
  const keys = new Set();
  let paramsRaw;
  while (raw[pos] !== '}') {
    const keyStart = pos; stringEnd();
    const key = JSON.parse(raw.slice(keyStart,pos));
    if (keys.has(key)) throw new MonitorTelemetryError('monitor_invalid_batch','Duplicate envelope field');
    keys.add(key); whitespace(); pos++; whitespace();
    const start = pos; valueEnd();
    if (key === 'params') paramsRaw = raw.slice(start,pos);
    whitespace(); if (raw[pos] === ',') {pos++;whitespace();}
  }
  if (!paramsRaw || monitorBytes(paramsRaw).length > MONITOR_AGENT_LIMITS.batchBytes) throw new MonitorTelemetryError('monitor_invalid_batch','Invalid batch params');
  return {...rpc,paramsRaw};
}

/** Every fragment is immutable; even incompressible batches never grow a shared BLOB. */
export function encodeMonitorBucket(samples,probes) {
  const encoded = monitorBytes(JSON.stringify({samples,probes}));
  if (encoded.length > MONITOR_STATE_BYTES) throw new MonitorTelemetryError('monitor_storage_overflow','Batch storage overflow');
  const parts = [];
  for (let offset = 0; offset < encoded.length; offset += MONITOR_BUCKET_BYTES) parts.push(encoded.slice(offset,offset+MONITOR_BUCKET_BYTES));
  return parts;
}

export function decodeMonitorBucket(parts) {
  const length = parts.reduce((n,p)=>n+p.length,0);
  if (length > MONITOR_STATE_BYTES) throw new MonitorTelemetryError('monitor_storage_overflow','Bucket storage overflow');
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {buffer.set(part,offset);offset += part.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
}

// The old UTF-8 layout remains readable; gzip is storage encoding, never a wire change.
export async function compressMonitorBytes(bytes) {
  const packed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  return packed.length < bytes.length ? packed : bytes;
}

export async function expandMonitorBytes(value, limit = MONITOR_STATE_BYTES) {
  const bytes = typeof value === 'string' ? monitorBytes(value) : new Uint8Array(value);
  if (bytes[0] !== 31 || bytes[1] !== 139) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];let length = 0;
  try {
    while (true) {
      const {done,value:chunk} = await reader.read();if (done) break;
      length += chunk.length;
      if (length > limit) throw new MonitorTelemetryError('monitor_storage_overflow','Storage expansion overflow');
      chunks.push(chunk);
    }
  } finally {await reader.cancel();}
  const result = new Uint8Array(length);let offset = 0;
  for (const chunk of chunks) {result.set(chunk,offset);offset += chunk.length;}
  return result;
}

export async function monitorReceiptText(value) {
  return new TextDecoder('utf-8',{fatal:true}).decode(await expandMonitorBytes(value,524288));
}

export async function packMonitorBucket(samples,probes) {
  const bytes = monitorBytes(JSON.stringify({samples,probes}));
  if (bytes.length > MONITOR_STATE_BYTES) throw new MonitorTelemetryError('monitor_storage_overflow','Batch storage overflow');
  const packed = await compressMonitorBytes(bytes),parts = [];
  for (let offset=0;offset<packed.length;offset+=MONITOR_BUCKET_BYTES) parts.push(packed.slice(offset,offset+MONITOR_BUCKET_BYTES));
  return parts;
}

export async function unpackMonitorBucket(parts) {
  const bytes = new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;
  for (const part of parts) {bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await expandMonitorBytes(bytes)));
}

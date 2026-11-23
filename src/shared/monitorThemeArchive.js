import { AppError } from '../utils/errors.js';
import { validMonitorShort } from './monitorThemes.js';

export const MONITOR_ARCHIVE_LIMIT = 32 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_PAYLOAD = 64 * 1024 * 1024;
const MAX_STREAM = MAX_PAYLOAD + 9 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const invalid = () => new AppError('monitorThemeArchiveInvalid', 400);
const decoder = new TextDecoder('utf-8', { fatal: true });
const field = bytes => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
function octal(bytes) {
  const value = field(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw invalid();
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw invalid();
  return number;
}

export function monitorArchivePath(raw, directory = false) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\\:\x00-\x1f\x7f]/.test(raw) || raw.startsWith('/')) throw invalid();
  const normalized = raw.replace(/^(\.\/)+/, '').replace(directory ? /\/+$/ : /$^/, '');
  if (directory && !normalized) return '';
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw invalid();
  return normalized;
}

function paxFields(bytes) {
  const result = {};
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    if (space < 0) throw invalid();
    const encoded = decoder.decode(bytes.subarray(at, space));
    if (!/^\d+$/.test(encoded)) throw invalid();
    const length = Number(encoded), end = at + length;
    if (!Number.isSafeInteger(length) || length <= space - at + 2 || end > bytes.length || bytes[end - 1] !== 10) throw invalid();
    const record = decoder.decode(bytes.subarray(space + 1, end - 1)), equals = record.indexOf('=');
    if (equals <= 0) throw invalid();
    result[record.slice(0, equals)] = record.slice(equals + 1);
    at = end;
  }
  return result;
}

// Consume file payloads in-place; only a header or bounded manifest is copied into memory.
class ArchiveReader {
  constructor(reader, onChunk) { this.reader = reader; this.onChunk = onChunk; this.chunk = new Uint8Array(); this.at = 0; this.offset = 0; this.total = 0; }
  async next() {
    if (this.at < this.chunk.length) return true;
    const { value, done } = await this.reader.read();
    if (done) return false;
    this.total += value.length;
    if (this.total > MAX_STREAM) throw invalid();
    await this.onChunk(value);
    this.chunk = value; this.at = 0;
    return this.next();
  }
  async read(length) {
    const bytes = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      if (!await this.next()) { if (!at) return null; throw invalid(); }
      const size = Math.min(length - at, this.chunk.length - this.at);
      bytes.set(this.chunk.subarray(this.at, this.at + size), at);
      this.at += size; this.offset += size; at += size;
    }
    return bytes;
  }
  async skip(length) {
    while (length > 0) {
      if (!await this.next()) throw invalid();
      const size = Math.min(length, this.chunk.length - this.at);
      this.at += size; this.offset += size; length -= size;
    }
  }
}

export async function parseMonitorThemeArchive(source, onChunk = async () => {}) {
  let compressed = 0, reader;
  try {
    if (!source) throw invalid();
    const counted = source.pipeThrough(new TransformStream({ transform(chunk, controller) {
      compressed += chunk.byteLength;
      if (compressed > MONITOR_ARCHIVE_LIMIT) throw new AppError('monitorThemeArchiveTooLarge', 413);
      controller.enqueue(chunk);
    } }));
    reader = new ArchiveReader(counted.pipeThrough(new DecompressionStream('gzip')).getReader(), onChunk);
    const files = Object.create(null), entries = new Map(), dirs = new Set();
    let manifest, preview, payload = 0, count = 0, fileCount = 0, override = {}, longName = '';
    while (true) {
      const header = await reader.read(512);
      if (!header) throw invalid();
      if (header.every(byte => byte === 0)) {
        const second = await reader.read(512);
        if (!second || second.some(byte => byte !== 0)) throw invalid();
        let padding = 0;
        while (await reader.next()) {
          const rest = reader.chunk.subarray(reader.at);
          padding += rest.length;
          if (padding > 1024 * 1024 || rest.some(byte => byte !== 0)) throw invalid();
          reader.offset += rest.length; reader.at = reader.chunk.length;
        }
        break;
      }
      if (++count > MAX_ENTRIES) throw invalid();
      const checksum = octal(header.subarray(148, 156));
      const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== actual) throw invalid();
      const type = String.fromCharCode(header[156] || 48);
      const headerSize = octal(header.subarray(124, 136));
      if (headerSize > MAX_FILE) throw invalid();
      if (['x', 'g', 'L'].includes(type)) {
        if (headerSize > 64 * 1024) throw invalid();
        const data = await reader.read(headerSize);
        if (!data) throw invalid();
        if (type === 'L') longName = field(data).replace(/\n$/, '');
        else {
          const values = paxFields(data);
          if (values.linkpath || (type === 'g' && (values.path || values.size))) throw invalid();
          if (type === 'x') override = values;
        }
        await reader.skip((512 - headerSize % 512) % 512);
        continue;
      }
      if (!['0', '5'].includes(type)) throw invalid();
      let size = headerSize;
      if (override.size !== undefined) {
        if (!/^\d+$/.test(override.size)) throw invalid();
        size = Number(override.size);
      }
      if (!Number.isSafeInteger(size) || size > MAX_FILE || (type === '5' && size !== 0)) throw invalid();
      const prefix = field(header.subarray(345, 500));
      const raw = override.path || longName || (prefix ? prefix + '/' : '') + field(header.subarray(0, 100));
      const name = monitorArchivePath(raw, type === '5');
      override = {}; longName = '';
      if (name) {
        if (entries.has(name)) throw invalid();
        const parts = name.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join('/');
          if (entries.get(parent) === '0') throw invalid();
          dirs.add(parent);
        }
        if (type === '0' && dirs.has(name)) throw invalid();
        entries.set(name, type);
        if (type === '5') dirs.add(name);
        if (type === '0') fileCount++;
        if (fileCount + dirs.size > MAX_ENTRIES) throw invalid();
      }
      payload += size;
      if (payload > MAX_PAYLOAD) throw invalid();
      if (type === '0' && name.startsWith('dist/')) files[name.slice(5)] = { offset: reader.offset, size };
      if (type === '0' && name === 'preview.png') preview = { offset: reader.offset, size };
      if (name === 'theme.json') {
        if (size > 64 * 1024) throw invalid();
        manifest = JSON.parse(decoder.decode(await reader.read(size)));
      } else await reader.skip(size);
      await reader.skip((512 - size % 512) % 512);
    }
    if (!manifest || !validMonitorShort(manifest.short) || !files['index.html'] ||
        ['name', 'description', 'version', 'author', 'url'].some(key => typeof manifest[key] !== 'string')) throw invalid();
    const clean = Object.fromEntries(['name', 'short', 'description', 'version', 'author', 'url', 'config'].filter(key =>
      Object.hasOwn(manifest, key)).map(key => [key, manifest[key]]));
    return { manifest: clean, files, ...(preview ? { preview } : {}), size: reader.total, compressedSize: compressed };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  } finally {
    if (reader) { try { await reader.reader.cancel(); } catch {} }
  }
}

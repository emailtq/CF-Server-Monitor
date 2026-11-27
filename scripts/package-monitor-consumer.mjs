import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// Fixed ustar metadata and sorted names keep local archives reproducible.
export function packageConsumer(root, manifest, extraFiles = []) {
  const chunks = [];
  const add = (name, data) => {
    if (Buffer.byteLength(name) > 100) throw new Error(`Archive path too long: ${name}`);
    const header = Buffer.alloc(512);
    header.write(name); header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  };
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${relative}/${entry.name}`, target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, name);
      else if (entry.isFile()) add(name, fs.readFileSync(target));
      else throw new Error(`Unsupported archive entry: ${target}`);
    }
  };
  add('theme.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  for (const file of extraFiles) if (fs.existsSync(path.join(root, file))) add(file, fs.readFileSync(path.join(root, file)));
  walk(path.join(root, 'dist'), 'dist');
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

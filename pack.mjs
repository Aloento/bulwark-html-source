#!/usr/bin/env node
/**
 * pack.mjs — build dist/html-source-<version>.zip from this folder.
 *
 * The installer only accepts a handful of extensions and wants manifest.json
 * and entrypoint at the ZIP root, so a hand-rolled store/deflate writer keeps
 * this dependency-free and deterministic. Run: node pack.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['manifest.json', 'index.js'];

const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const OUT_DIR = join(HERE, 'dist');
const OUT = join(OUT_DIR, `html-source-${manifest.version}.zip`);

// ── CRC-32 ────────────────────────────────────────────────────
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── DOS timestamp ─────────────────────────────────────────────
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

const locals = [];
const centrals = [];
let offset = 0;

for (const name of FILES) {
  const raw = readFileSync(join(HERE, name));
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(raw);
  const nameBuf = Buffer.from(name, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);

  locals.push(local, nameBuf, body);
  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(FILES.length, 8);
end.writeUInt16LE(FILES.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));

// ── read the archive back and report ──────────────────────────
const zip = readFileSync(OUT);
const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const count = zip.readUInt16LE(eocd + 10);
let p = zip.readUInt32LE(eocd + 16);
console.log(`built ${OUT}`);
console.log(`  ${statSync(OUT).size} bytes, ${count} entries`);
for (let i = 0; i < count; i++) {
  const method = zip.readUInt16LE(p + 10);
  const csize = zip.readUInt32LE(p + 20);
  const usize = zip.readUInt32LE(p + 24);
  const nlen = zip.readUInt16LE(p + 28);
  const xlen = zip.readUInt16LE(p + 30);
  const clen = zip.readUInt16LE(p + 32);
  const name = zip.toString('utf8', p + 46, p + 46 + nlen);
  console.log(`  ${name}  ${usize} bytes  (${method === 8 ? 'deflate' : 'store'}, ${csize} on disk)`);
  p += 46 + nlen + xlen + clen;
}

// the installer's own limits
const LIMIT_ZIP = 5 * 1024 * 1024;
const LIMIT_FILES = 200;
const LIMIT_ENTRY = 20 * 1024 * 1024;
const size = statSync(OUT).size;
const problems = [];
if (size > LIMIT_ZIP) problems.push(`zip is ${size} bytes (limit ${LIMIT_ZIP})`);
if (count > LIMIT_FILES) problems.push(`${count} files (limit ${LIMIT_FILES})`);
if (problems.length) {
  console.error('LIMITS: ' + problems.join('; '));
  process.exit(1);
}
console.log('  limits ok (≤5 MB, ≤200 files)');

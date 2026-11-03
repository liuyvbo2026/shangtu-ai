import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { fail, Fault, hash, id, integer, string } from './core.mjs';

export function safeDirectory(dir) {
  fail(path.isAbsolute(dir), 'UNSAFE_PATH', 'Use an absolute data directory');
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const st = fs.lstatSync(current);
    fail(st.isDirectory() && !st.isSymbolicLink(), 'UNSAFE_PATH', 'Directory symlinks are not allowed');
  }
  return fs.realpathSync(dir);
}
export function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
export function readRegular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fail(fs.fstatSync(fd).isFile(), 'UNSAFE_PATH', 'Expected a regular file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Validates containers/dimensions, not a substitute for a full image decoder.
export function imageInfo(bytes, config) {
  fail(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= config.maxAssetBytes, 'INVALID_IMAGE', 'Empty or oversized image');
  let width, height, mediaType, extension;
  try {
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      mediaType = 'image/png'; extension = 'png';
      let offset = 8, first = true, ended = false; const compressed = [];
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        fail(offset + 12 + length <= bytes.length, 'INVALID_IMAGE', 'Truncated PNG');
        const chunk = bytes.subarray(offset + 8, offset + 8 + length);
        fail(crc32(bytes.subarray(offset + 4, offset + 8 + length)) === bytes.readUInt32BE(offset + 8 + length), 'INVALID_IMAGE', 'Invalid PNG checksum');
        if (first) {
          fail(type === 'IHDR' && length === 13, 'INVALID_IMAGE', 'Missing PNG header');
          width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); first = false;
          fail(width * height <= config.maxPixels, 'INVALID_IMAGE', 'Oversized image');
        } else fail(type !== 'IHDR', 'INVALID_IMAGE', 'Duplicate PNG header');
        if (type === 'IDAT') compressed.push(chunk);
        offset += length + 12;
        if (type === 'IEND') { fail(length === 0, 'INVALID_IMAGE', 'Invalid PNG end'); ended = true; break; }
      }
      fail(ended && offset === bytes.length && compressed.length > 0, 'INVALID_IMAGE', 'Invalid PNG container');
      // Reject broken streams and decompression bombs; pixel format normalization is deferred.
      inflateSync(Buffer.concat(compressed), { maxOutputLength: Math.min(config.maxPixels * 8 + height * 8, width * height * 8 + height * 8) });
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      mediaType = 'image/jpeg'; extension = 'jpg';
      fail(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'INVALID_IMAGE', 'Truncated JPEG');
      let p = 2;
      while (p + 4 <= bytes.length) {
        fail(bytes[p++] === 0xff, 'INVALID_IMAGE', 'Invalid JPEG marker');
        while (bytes[p] === 0xff) p++;
        const marker = bytes[p++];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const len = bytes.readUInt16BE(p);
        fail(len >= 2 && p + len <= bytes.length, 'INVALID_IMAGE', 'Truncated JPEG segment');
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          fail(len >= 8, 'INVALID_IMAGE', 'Invalid JPEG dimensions');
          height = bytes.readUInt16BE(p + 3); width = bytes.readUInt16BE(p + 5);
        }
        p += len;
      }
    } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
      mediaType = 'image/webp'; extension = 'webp';
      fail(bytes.length >= 30 && bytes.readUInt32LE(4) + 8 === bytes.length, 'INVALID_IMAGE', 'Invalid WebP container');
      let p = 12, payload = false;
      while (p + 8 <= bytes.length) {
        const kind = bytes.toString('ascii', p, p + 4), length = bytes.readUInt32LE(p + 4), start = p + 8;
        fail(start + length <= bytes.length, 'INVALID_IMAGE', 'Truncated WebP');
        if (kind === 'VP8X') { fail(length === 10, 'INVALID_IMAGE', 'Invalid WebP header'); width = bytes.readUIntLE(start + 4, 3) + 1; height = bytes.readUIntLE(start + 7, 3) + 1; }
        if (kind === 'VP8 ') { fail(length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d,0x01,0x2a])), 'INVALID_IMAGE', 'Invalid WebP frame'); width ??= bytes.readUInt16LE(start + 6) & 0x3fff; height ??= bytes.readUInt16LE(start + 8) & 0x3fff; payload = true; }
        if (kind === 'VP8L') { fail(length >= 5 && bytes[start] === 0x2f, 'INVALID_IMAGE', 'Invalid WebP lossless frame'); const bits = bytes.readUInt32LE(start + 1); width ??= (bits & 0x3fff) + 1; height ??= ((bits >>> 14) & 0x3fff) + 1; payload = true; }
        p = start + length + (length % 2);
      }
      fail(p === bytes.length && payload, 'INVALID_IMAGE', 'Unsupported or invalid WebP');
    }
    integer(width, 'image width'); integer(height, 'image height');
    fail(width * height <= config.maxPixels && config.allowedMediaTypes.includes(mediaType), 'INVALID_IMAGE', 'Unsupported or oversized image');
    return { width, height, mediaType, extension };
  } catch (error) {
    if (error instanceof Fault && error.code === 'INVALID_IMAGE') throw error;
    throw new Fault('INVALID_IMAGE', 'Invalid image structure or dimensions');
  }
}

export class Files {
  constructor(root, config) {
    this.root = safeDirectory(root); this.config = config;
    for (const kind of ['original','derived']) safeDirectory(path.join(this.root, kind));
  }
  resolve(relative) {
    fail(/^(original|derived)\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(relative), 'UNSAFE_PATH', 'Invalid asset path');
    const target = path.join(this.root, relative);
    fail(fs.realpathSync(this.root) === this.root, 'UNSAFE_PATH', 'Changed storage root');
    const parent = fs.lstatSync(path.dirname(target));
    fail(parent.isDirectory() && !parent.isSymbolicLink(), 'UNSAFE_PATH', 'Invalid asset directory');
    return target;
  }
  prepare(bytes, { kind = 'original', name = 'image', mediaType, parentId = null } = {}) {
    fail(['original','derived'].includes(kind), 'INVALID_INPUT', 'Invalid asset kind');
    string(name, 'filename', 200);
    fail(!/[\/\\]/.test(name) && !name.startsWith('.'), 'INVALID_INPUT', 'Filename cannot contain paths');
    const info = imageInfo(bytes, this.config);
    fail(mediaType === undefined || mediaType === info.mediaType, 'INVALID_IMAGE', 'Declared media type does not match bytes');
    const assetId = id(), relative = `${kind}/${assetId}.${info.extension}`;
    writeExclusive(this.resolve(relative), bytes);
    return { id: assetId, kind, parentId, path: relative, name, ...info, byteLength: bytes.length, sha256: hash(bytes) };
  }
  read(asset) {
    try {
      const bytes = readRegular(this.resolve(asset.path));
      fail(bytes.length === asset.byteLength && hash(bytes) === asset.sha256, 'ASSET_CORRUPT', 'Asset checksum mismatch', 500);
      return bytes;
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('ASSET_UNAVAILABLE', 'Asset file unavailable', 500);
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.mjs';
import { fail, hash, id } from './core.mjs';
import { safeDirectory, readRegular, writeExclusive, syncDirectory } from './files.mjs';

const isWithin = (child, parent) => child === parent || child.startsWith(parent + path.sep);
export function backup(store, destination) {
  const target = path.resolve(destination);
  fail(!isWithin(target,store.root) && !isWithin(store.root,target), 'INVALID_BACKUP', 'Backup must be separate from data directory');
  fail(!fs.existsSync(target), 'DESTINATION_EXISTS', 'Backup destination must not exist', 409);
  // Synchronous snapshot: this process owns the writer lock and no JS callbacks can mutate
  // DB/files between VACUUM INTO and file copy. No reliance on copying WAL files.
  safeDirectory(path.dirname(target));
  const staging = `${target}.staging-${id()}`; safeDirectory(staging);
  try {
    const dbPath = path.join(staging,'store.sqlite');
    store.db.prepare('VACUUM INTO ?').run(dbPath);
    const manifest = {format:'aigc-backend-backup',schemaVersion:1,database:{path:'store.sqlite',sha256:hash(readRegular(dbPath))},assets:[]};
    for (const row of store.all('SELECT id FROM assets ORDER BY id')) {
      const a = store.asset(row.id), bytes = store.readAsset(a.id);
      const relative = `files/${a.path}`;
      safeDirectory(path.dirname(path.join(staging,relative))); writeExclusive(path.join(staging,relative),bytes);
      manifest.assets.push({id:a.id,path:relative,sha256:a.sha256,byteLength:a.byteLength});
    }
    writeExclusive(path.join(staging,'manifest.json'),Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
    const fd=fs.openSync(dbPath,'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    syncDirectory(staging); fs.renameSync(staging,target); syncDirectory(path.dirname(target));
    return manifest;
  } catch(error) { fs.rmSync(staging,{recursive:true,force:true}); throw error; }
}

export function restore(source, destination) {
  const src = fs.realpathSync(source), target = path.resolve(destination);
  fail(!fs.existsSync(target), 'DESTINATION_EXISTS', 'Restore destination must not exist', 409);
  fail(!isWithin(target,src) && !isWithin(src,target), 'INVALID_BACKUP', 'Restore must use a separate directory');
  const manifest = JSON.parse(readRegular(path.join(src,'manifest.json')));
  fail(manifest.format==='aigc-backend-backup' && manifest.schemaVersion===1 && manifest.database.path==='store.sqlite' && Array.isArray(manifest.assets), 'INVALID_BACKUP', 'Invalid manifest');
  const dbBytes=readRegular(path.join(src,'store.sqlite'));
  fail(hash(dbBytes)===manifest.database.sha256,'INVALID_BACKUP','Database checksum mismatch');
  const entries = new Set(), ids = new Set();
  for (const a of manifest.assets) {
    fail(typeof a.path==='string' && /^files\/(original|derived)\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(a.path) && !entries.has(a.path) && !ids.has(a.id), 'INVALID_BACKUP','Invalid or duplicate asset path');
    entries.add(a.path); ids.add(a.id);
    fail(fs.realpathSync(path.dirname(path.join(src,a.path)))===path.dirname(path.join(src,a.path)), 'INVALID_BACKUP','Backup symlinks are not allowed');
    const bytes=readRegular(path.join(src,a.path));
    fail(hash(bytes)===a.sha256 && bytes.length===a.byteLength,'INVALID_BACKUP','Asset checksum mismatch');
  }
  safeDirectory(path.dirname(target)); const staging=`${target}.staging-${id()}`; safeDirectory(staging);
  let verify;
  try {
    writeExclusive(path.join(staging,'store.sqlite'),dbBytes);
    for (const a of manifest.assets) {
      const output=path.join(staging,a.path); safeDirectory(path.dirname(output)); writeExclusive(output,readRegular(path.join(src,a.path)));
    }
    // Open read-only before Store migrations; a backup is never allowed to execute its schema.
    verify=new DatabaseSync(path.join(staging,'store.sqlite'),{readOnly:true});
    fail(verify.prepare('PRAGMA integrity_check').get().integrity_check==='ok' && verify.prepare('PRAGMA foreign_key_check').all().length===0,'INVALID_BACKUP','Database integrity check failed');
    fail(verify.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").all().length===0,'INVALID_BACKUP','Unexpected schema objects');
    fail(verify.prepare('SELECT version FROM schema_version').get()?.version===1,'INVALID_BACKUP','Unsupported schema version');
    const assets=verify.prepare('SELECT * FROM assets ORDER BY id').all();
    fail(assets.length===manifest.assets.length,'INVALID_BACKUP','Asset inventory mismatch');
    for (const a of assets) {
      const m=manifest.assets.find(x=>x.id===a.id);
      fail(m && m.path===`files/${a.path}` && m.sha256===a.sha256 && m.byteLength===a.byte_length,'INVALID_BACKUP','Database/file inventory mismatch');
    }
    verify.close(); verify=null; syncDirectory(staging);
    fs.renameSync(staging,target); syncDirectory(path.dirname(target));
    return {destination:target,assets:assets.length};
  } catch(error) { verify?.close(); fs.rmSync(staging,{recursive:true,force:true}); throw error; }
}

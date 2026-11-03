import { Store } from './store.mjs';
import { backup, restore } from './backup.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './core.mjs';

const [command,source,destination]=process.argv.slice(2);
if(!['backup','restore'].includes(command)||!source||!destination) {
  console.error('Usage: node backend/maintenance.mjs backup|restore /absolute/source /absolute/new-destination'); process.exitCode=2;
} else if(command==='backup') {
  fail(fs.existsSync(path.join(source,'store.sqlite')),'NOT_FOUND','Backup source database does not exist',404);
  const store=new Store({dataDir:source});
  try { const manifest=backup(store,destination); console.log(JSON.stringify({destination,assets:manifest.assets.length})); }
  finally {store.close();}
} else console.log(JSON.stringify(restore(source,destination)));

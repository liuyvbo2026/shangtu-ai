import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = new URL('../',import.meta.url);
let count = 0;
for (const directory of ['src/editor/','tests/editor/']) {
  for (const name of await readdir(new URL(directory,root))) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath,['--check',fileURLToPath(new URL(directory+name,root))],{encoding:'utf8'});
    if (result.status !== 0) {process.stderr.write(result.stderr || result.error?.message || 'Syntax check failed'); process.exit(1);}
    count++;
  }
}
console.log(`05A syntax: ${count} JavaScript modules passed`);

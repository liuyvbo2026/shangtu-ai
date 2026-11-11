import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=['server.mjs','src/integration-client.js','src/api-settings.js','src/product-input.js','src/result-tools.js','src/text-tools.js','src/quality-tools.js','scripts/start-configured.mjs','scripts/local-service.mjs','scripts/validate-mimo.mjs'];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())walk(p);else if(/\.(mjs|js)$/.test(p))files.push(p);}}
walk('backend');walk('tests/integration');
for(const f of files){const r=spawnSync(process.execPath,['--check',f],{stdio:'inherit'});if(r.status)process.exit(r.status);}
console.log(`Integration syntax: ${files.length} files passed`);

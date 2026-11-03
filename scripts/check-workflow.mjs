import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=[...readdirSync(new URL('../src/workflow/',import.meta.url)).filter(n=>n.endsWith('.js')).map(n=>`src/workflow/${n}`),
  'tests/workflow/fixtures.mjs','tests/workflow.test.mjs','tests/workflow-stage2.test.mjs','scripts/workflow-examples.mjs','scripts/check-workflow.mjs'];
for(const file of files) {const result=spawnSync(process.execPath,['--check',file],{cwd:root,encoding:'utf8'});if(result.status!==0){console.error(result.stderr);process.exit(result.status??1);}}
console.log(`Workflow syntax: ${files.length} files passed`);

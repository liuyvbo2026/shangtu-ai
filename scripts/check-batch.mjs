import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files = ['tests/batch.test.mjs', 'tests/batch-fixtures.mjs', 'tests/stage2-batch.contract.mjs',
  'scripts/check-batch.mjs', 'scripts/record-06a-evidence.mjs', ...readdirSync('src/batch').filter(f => f.endsWith('.js')).map(f => `src/batch/${f}`)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`06A syntax: ${files.length} files passed.`);

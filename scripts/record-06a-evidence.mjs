// Reproducible local evidence runner. Test fixtures never enter the user asset library.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixtures, completed, project} from '../tests/batch-fixtures.mjs';
import {createSubmission, aggregateBatch, buildDownloadManifest} from '../src/batch/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'artifacts/06a-batch-results');
fs.mkdirSync(directory, {recursive: true});
const save = (name, data) => fs.writeFileSync(path.join(directory, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
const hashFile = relative => ({path: relative, sha256: createHash('sha256').update(fs.readFileSync(path.resolve(root, relative))).digest('hex')});
const files = [...fs.readdirSync(path.join(root, 'src/batch')).map(f => `src/batch/${f}`),
  'tests/batch.test.mjs', 'tests/batch-fixtures.mjs', 'tests/stage2-batch.contract.mjs', 'scripts/check-batch.mjs',
  'scripts/record-06a-evidence.mjs', 'docs/06A-BATCH-RESULTS.md'];
const backendFiles = ['store.mjs', 'core.mjs', 'schema.sql', 'files.mjs', 'http.mjs', 'test-processor.mjs']
  .map(f => `../liuyubo-aigc-stage2-backend/backend/${f}`);
const ruleFiles = ['05-platform-transitions.json', '06-country-change.json', '08-country-language-transitions.json']
  .map(f => `artifacts/reference-2026-10-28/${f}`);
const before = [...files, ...backendFiles, ...ruleFiles].map(hashFile);
save('rule-inputs.json', ruleFiles.map(file => ({...hashFile(file), data: JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))})));
const commands = [];
for (const [command, args, output] of [
  ['npm', ['run', 'check'], 'npm-check.txt'],
  ['npm', ['test'], 'npm-test.txt'],
  ['npm', ['run', 'test:stage2'], 'stage2-contract-test.txt']
]) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8'});
  save(output, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  commands.push({command: [command, ...args].join(' '), exitCode: result.status, output,
    totals: (result.stdout ?? '').split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line))});
}
const {batch} = fixtures();
const sources = batch.items.map(item => completed(batch, item.id));
sources[1].task.state = 'partial'; sources[1].task.children[1].state = 'failed';
const tasks = sources.map(source => project(batch, source.task, source.assets));
save('example-frozen-batch.json', batch);
save('example-requests.json', batch.items.map(item => createSubmission(batch, item.id)));
save('example-summary.json', aggregateBatch(batch, tasks));
save('example-download-manifest.json', buildDownloadManifest(batch, tasks));
const after = before.map(item => hashFile(item.path));
const changedDuringRun = before.filter((item, i) => item.sha256 !== after[i].sha256).map(item => item.path);
const evidence = {scope: '06A pure logic and in-process stage2 contract; synthetic fixtures only',
  recordedAt: new Date().toISOString(), timezone: 'Asia/Shanghai', node: process.version,
  platform: process.platform, commands, changedDuringRun, sourceFiles: after,
  notRun: ['real model calls', 'HTTP service integration', 'worker scheduling', 'server downloads', 'browser/full-site QA']};
save('evidence.json', evidence);
console.log(JSON.stringify({directory, commands, changedDuringRun}, null, 2));
if (commands.some(c => c.exitCode !== 0) || changedDuringRun.length) process.exitCode = 1;

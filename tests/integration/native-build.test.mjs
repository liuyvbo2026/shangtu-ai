import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {prepareNative} from '../../backend/integration/native-build.mjs';
test('native build shares immutable compiled bytes and atomically installs concurrent stores',{skip:process.platform!=='darwin',timeout:120000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-build-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'fixture.swift'),a=path.join(dir,'a/tool'),b=path.join(dir,'b/tool');fs.writeFileSync(source,'print("native-build-fixture-1")\n');
 await Promise.all([prepareNative(source,a),prepareNative(source,b)]);assert.deepEqual(fs.readFileSync(a),fs.readFileSync(b));assert.equal(execFileSync(a,{encoding:'utf8'}).trim(),'native-build-fixture-1');
 const stat=fs.statSync(a);await prepareNative(source,a);assert.equal(fs.statSync(a).mtimeMs,stat.mtimeMs);
 assert.deepEqual(fs.readdirSync(path.dirname(a)),['tool']);
});

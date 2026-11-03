// Explicit, finite deterministic test runner. Never loaded by server.mjs or src/app.js.
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {prepareWorkflow,executeImage,recordImageResult,rerunImage,aggregateResults,schemas,PROMPT_TEMPLATES,NODE_CONTRACTS,DEFAULT_POLICY,createStage2Submission,WorkflowError} from '../src/workflow/index.js';
import {inputFixture,deterministicHandlers} from '../tests/workflow/fixtures.mjs';

const directory=new URL('../examples/workflow/',import.meta.url);
await fs.mkdir(directory,{recursive:true});
const write=(name,value)=>fs.writeFile(new URL(name,directory),JSON.stringify(value,null,2)+'\n');
const input=inputFixture(),handlers=deterministicHandlers();
const prepared=await prepareWorkflow(input,handlers);assert.equal(prepared.status,'ready');
async function kit(p,h) { let results={};for(const image of p.plan.images)results=recordImageResult(results,await executeImage(p,image.id,h,{results}));return results; }
const success=await kit(prepared,handlers);
const partialHandlers=deterministicHandlers({failures:{'scene-1':{untilAttempt:1}}});
const partial=await kit(prepared,partialHandlers);
const rerun=await rerunImage(prepared,partial,'scene-1',partialHandlers);
const unchanged=Object.keys(partial).filter(id=>id!=='scene-1').every(id=>JSON.stringify(partial[id])===JSON.stringify(rerun.results[id]));
assert.equal(unchanged,true);
const invalid=await prepareWorkflow(input,deterministicHandlers({mutatePlan:p=>{p.images.pop();return p;}}));
assert.equal(invalid.status,'failed');
const failure=await executeImage(prepared,'selling-1',{...handlers,compose:async()=>{throw new WorkflowError('COMPOSE_FAILED');}});
const resumed=await executeImage(prepared,'selling-1',handlers,{resume:failure.checkpoint,attempt:2});assert.equal(resumed.status,'succeeded');
const backendProduct={...input.product,facts:{confirmed:input.product.facts,unknowns:input.product.unknowns}};
const report={scope:'03A deterministic structure/flow verification only',testOnly:true,qualityClaim:false,
  scenarios:{success:aggregateResults(prepared,success),partial:aggregateResults(prepared,partial),
    illegalPlan:{status:invalid.status,error:invalid.error},singleImageRerun:{...aggregateResults(prepared,rerun.results),unchangedSiblingRecords:unchanged},
    resume:{failedNode:failure.trace.at(-1).id,resumedNodes:resumed.trace.map(n=>n.id),status:resumed.status}}};
await Promise.all([
  write('input.json',input),write('understanding.json',prepared.understanding),write('plan.json',prepared.plan),write('prepared.json',prepared),
  write('policy.json',DEFAULT_POLICY),write('prompt-catalog.json',PROMPT_TEMPLATES),write('node-contracts.json',NODE_CONTRACTS),
  ...Object.entries(schemas).map(([name,schema])=>write(`${name}.schema.json`,{$schema:'https://json-schema.org/draft/2020-12/schema',title:`03A ${name}`, ...schema})),
  write('success.json',{...aggregateResults(prepared,success),results:success}),
  write('partial.json',{...aggregateResults(prepared,partial),results:partial}),write('invalid-plan.json',invalid),
  write('single-image-rerun.json',{...report.scenarios.singleImageRerun,target:rerun.results['scene-1']}),
  write('resume.json',{failure,resumed}),write('stage2-submission.json',createStage2Submission(prepared,backendProduct,'example-only-do-not-submit')),
  write('verification.json',report)
]);
console.log(JSON.stringify({directory:fileURLToPath(directory),...report},null,2));

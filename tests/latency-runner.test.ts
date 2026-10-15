import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);
// Failure specification: repeated runner invocations create duplicate writes;
// before/after use different base commits; timings are dropped; verification
// publishes incomplete content or does not persist its exact command/results.
test('bounded latency runner reuses completed requests and verifies all eight changes over HTTP',async()=>{
 const server=await startLocal({port:0,test:true,source:true});
 try{
  const response=await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'profile',name:'Profile',files:[]})});assert.equal(response.status,201);
  const state=join(server.dir,'profile');const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'};
  const run=(phase:string)=>exec('python3',['scripts/profile-submissions.py','profile','--state',state,'--phase',phase,'--deployment','local'],{env});
  await run('before');const first=JSON.parse(await readFile(join(state,'state.json'),'utf8'));await run('before');assert.deepEqual(JSON.parse(await readFile(join(state,'state.json'),'utf8')),first);
  await run('after');await run('verify');const report=JSON.parse(await readFile(join(state,'report.json'),'utf8'));
  assert.equal(report.verifiedFiles,8);assert.ok(report.httpAttempts<=48);assert.equal(report.usageDelta.writes,8);assert.equal(report.usageDelta.artifacts,0);
  for(const phase of ['before','after']){assert.equal(report.phases[phase].samples.length,4);assert.ok(report.phases[phase].samples.every((r:any)=>r.stages.app>=0&&r.stages.r2_put>=0));}
  console.log(JSON.stringify({command:'node --import tsx --test tests/latency-runner.test.ts',report,externalProviderCalls:0}));
 }finally{await server.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);
// Failure specification: a pilot gets repeated when extending its sample; a
// completed phase creates billable work again; parallel results lose timings;
// failures vanish from the journal; p95/p99 or verification artifacts are absent.
test('bounded tail runner extends its pilot without repeating writes and verifies publication over HTTP',async()=>{
 const server=await startLocal({port:0,test:true,source:true});
 try{
  const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
  assert.equal((await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'tail',name:'Tail',files:[]})})).status,201);
  const state=join(server.dir,'tail');const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'};
  const run=(phase:string,extra:string[]=[],token=env.SQUALI_TOKEN)=>exec('python3',['scripts/measure-tail.py','tail','--state',state,'--phase',phase,'--deployment','local','--samples','8','--concurrency','2',...extra],{env:{...env,SQUALI_TOKEN:token}});
  await run('before',['--through','4']);const pilot=JSON.parse(await readFile(join(state,'state.json'),'utf8'));assert.equal(pilot.phases.before.complete,false);
  await run('before');const before=JSON.parse(await readFile(join(state,'state.json'),'utf8'));for(let i=0;i<4;i++)assert.deepEqual(before.operations['before-'+i],pilot.operations['before-'+i]);
  await run('before');assert.deepEqual(JSON.parse(await readFile(join(state,'state.json'),'utf8')),before);
  await run('after');const after=JSON.parse(await readFile(join(state,'state.json'),'utf8'));assert.equal(after.operations['after-pilot-read'].complete,true);await run('verify');const result=JSON.parse(await readFile(join(state,'report.json'),'utf8'));
  assert.equal(result.verifiedFiles,8);assert.equal(result.usageDelta.writes,16);assert.equal(result.usageDelta.artifacts,0);assert.equal(result.failures,0);
  for(const phase of ['before','after']){const r=result.phases[phase];assert.equal(r.samples.length,8);assert.ok(r.client.p50<=r.client.p95&&r.client.p95<=r.client.p99);assert.equal(r.client.p99,r.client.max);assert.ok(r.stages.db_connect.p99>=0);}
  console.log(JSON.stringify({command:'node --import tsx --test tests/tail-runner.test.ts',httpAttempts:result.httpAttempts,pilotReused:true,verifiedFiles:8,externalProviderCalls:0}));
 }finally{await server.close();}
});

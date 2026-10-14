import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';

// Failure specification: resumed measurements repeat writes; concurrency exceeds eight;
// incomplete publication is called success; secrets leak into reports; requests exceed
// their persistent cap; local measurements are labelled as production measurements.
test('bounded cloud acceptance CLI publishes 64 changes and reuses its completed journal',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:1});const exec=promisify(execFile);
 try{
  const args=['scripts/cloud-acceptance.py','acceptance','--state',server.dir+'/acceptance','--label','local validation'];
  const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_AGENT_TOKEN:'local-agent-test-token'};
  const first=await exec('python3',args,{env,timeout:60000});const result=JSON.parse(first.stdout);
  assert.equal(result.complete,true);assert.equal(result.dataset.changes,64);assert.equal(result.dataset.concurrency,8);assert.equal(result.results.publishedFiles,64);assert.equal(result.results.changesets,66);assert.equal(result.label,'local validation');assert.ok(result.httpAttempts<=160);
  const before=await server.sql`SELECT kind,attempts FROM weave_source_usage ORDER BY kind`;
  const second=JSON.parse((await exec('python3',args,{env,timeout:10000})).stdout);assert.deepEqual(second,result);assert.deepEqual(await server.sql`SELECT kind,attempts FROM weave_source_usage ORDER BY kind`,before);
  const journal=await readFile(server.dir+'/acceptance/state.json','utf8');assert.ok(!journal.includes(env.SQUALI_TOKEN));assert.ok(!journal.includes(env.SQUALI_AGENT_TOKEN));
  const [{count}]=await server.sql`SELECT count(*) FROM weave_changesets`;assert.equal(Number(count),66);
  const followArgs=['scripts/cloud-acceptance.py','acceptance','--state',server.dir+'/follow-up','--label','local optimization validation','--follow-up'];
  const follow=JSON.parse((await exec('python3',followArgs,{env,timeout:60000})).stdout);assert.equal(follow.complete,true);assert.equal(follow.dataset.changes,8);assert.equal(follow.results.publishedFiles,8);assert.equal(follow.results.changesets,75);assert.ok(follow.httpAttempts<=30);
  assert.equal(follow.results.usageAfter.source.writes-follow.results.usageBefore.source.writes,8,'Follow-up reuses the baseline and writes only eight new blobs');
  const connectionArgs=['scripts/cloud-acceptance.py','acceptance','--state',server.dir+'/connection-check','--label','local connection validation','--follow-up','--series','connection'];
  const connection=JSON.parse((await exec('python3',connectionArgs,{env,timeout:60000})).stdout);assert.equal(connection.complete,true);assert.equal(connection.results.changesets,84);assert.equal(connection.results.usageAfter.source.writes-connection.results.usageBefore.source.writes,8);assert.ok(connection.httpAttempts<=30);
  const afterConnection=await server.sql`SELECT kind,attempts FROM weave_source_usage ORDER BY kind`;
  assert.deepEqual(JSON.parse((await exec('python3',connectionArgs,{env,timeout:10000})).stdout),connection);assert.deepEqual(await server.sql`SELECT kind,attempts FROM weave_source_usage ORDER BY kind`,afterConnection);
  console.log(JSON.stringify({command:'node --import tsx --test tests/cloud-acceptance.test.ts',...result}));
 }finally{await server.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,readFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';

// Failure specification: counts pass despite missing refs/objects; native clone differs;
// source APIs hide bad trees/history; rerunning verification repeats a large clone;
// transient errors silently retry or expose credentials in the retained report;
// a rename with an edit loses unchanged lines from the original path;
// a correct Git export hides a corrupt canonical delta or parent mapping.
test('import verification checks complete native identity and reuses its successful transfer',async()=>{
 const server=await startLocal({port:0,test:true,source:true});const exec=promisify(execFile);
 try{
  const native=server.dir+'/native';await exec('git',['init','--initial-branch=main',native]);
  const git=(...args:string[])=>exec('git',['-C',native,...args]);await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  const stable=Array.from({length:20},(_,i)=>'Stable context '+i+'\n').join('');
  await writeFile(native+'/README',stable+'first\n');await git('add','.');await git('commit','-m','First');
  await git('mv','README','README.md');await writeFile(native+'/README.md',stable+'second\n');await writeFile(native+'/image.bin',Buffer.from([0,1,127,255]));await git('add','.');await git('commit','-m','Second');await git('tag','-a','v1','-m','Release');
  await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'verify',name:'Verify import',storage:'source',import:true,files:[]})});
  const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'};
  await exec('python3',['scripts/import-source.py','verify',native,'--state',server.dir+'/ingest'],{env});
  const args=['scripts/verify-import.py','verify',native,'--state',server.dir+'/verification','--file','README.md'];
  const first=JSON.parse((await exec('python3',args,{env,timeout:60000})).stdout);assert.equal(first.complete,true);assert.equal(first.commits,2);assert.equal(first.refs,2);assert.equal(first.gitTransfers,1);assert.equal(first.nativeFsck,true);assert.equal(first.blameMatchesNative,true);assert.equal(first.objects,8);assert.equal(first.canonicalChangesetsVerified,2);
  const usageBefore=await server.sql`SELECT * FROM weave_usage`;
  const second=JSON.parse((await exec('python3',args,{env,timeout:10000})).stdout);assert.deepEqual(second,first);assert.deepEqual(await server.sql`SELECT * FROM weave_usage`,usageBefore);
  assert.ok(!(await readFile(server.dir+'/verification/state.json','utf8')).includes(env.SQUALI_TOKEN));
  const [{git_oid:head}]=await server.sql`SELECT git_oid FROM weave_changesets WHERE project='verify' ORDER BY cardinality(parents) DESC LIMIT 1`;
  await server.sql`UPDATE weave_changesets SET files=jsonb_set(files,'{0,blob}',to_jsonb(${'f'.repeat(64)}::text)) WHERE project='verify' AND git_oid=${head}`;
  const damaged=await exec('python3',['scripts/verify-import.py','verify',native,'--state',server.dir+'/damaged-verification','--file','README.md'],{env,timeout:60000}).then(r=>({code:0,...r}),e=>e);
  assert.notEqual(damaged.code,0);assert.match(damaged.stderr,/Canonical/);const journal=JSON.parse(await readFile(server.dir+'/damaged-verification/state.json','utf8'));assert.equal(journal.gitTransfers,0,'Canonical corruption is detected before another transfer');
  console.log(JSON.stringify(first));
 }finally{await server.close();}
});

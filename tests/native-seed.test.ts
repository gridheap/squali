import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {writeFile,readFile,chmod,unlink} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);

test('native seeding sends bounded original-ref increments and preserves every object',{timeout:60000},async()=>{
 const server=await startLocal({port:0,test:true,source:true});
 try{
  const native=server.dir+'/input';await exec('git',['init','--initial-branch=main',native]);const git=async(...args:string[])=>(await exec('git',['-C',native,...args])).stdout.trim();
  await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  for(let i=1;i<=30;i++){await writeFile(native+'/README.md','version '+i+'\n');await git('add','.');await git('commit','-m','Version '+i);if(i%5===0)await git('tag','-a','v'+String(i).padStart(2,'0'),'-m','Release '+i);}
  const response=await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'seed',name:'Bounded seed',storage:'source',import:true,files:[]})});assert.equal(response.status,201);
  const token='sq_seed_fixture',lease='seed-lease';await server.sql`INSERT INTO weave_tokens(id,project,token_hash,label,role,expires_at) VALUES('seed-token','seed',${createHash('sha256').update(token).digest('hex')},'Seed fixture','admin',now()+interval '1 hour')`;
  await server.sql`INSERT INTO weave_github_imports(id,owner_id,repository_id,project_id,metadata,state,engine) VALUES('seed-import','reviewer',876,'seed','{}','running','source')`;
  await server.sql`INSERT INTO weave_native_jobs(import_id,state,lease,lease_until,token_id) VALUES('seed-import','running',${lease},now()+interval '1 hour','seed-token')`;
  const destination=server.dir+'/weave-seed.git';await exec('git',['init','--bare','--initial-branch=main',destination]);await exec('git',['--git-dir',destination,'config','receive.advertiseAtomic','false']);
  const hook=destination+'/hooks/pre-receive';await writeFile(hook,`#!/usr/bin/env python3
import json,pathlib,subprocess,sys
updates=[line.split() for line in sys.stdin]
new=[v[1] for v in updates if v[1]!='0'*40]
result=subprocess.run(['git','rev-list','--objects','--no-object-names',*new,'--not','--all'],capture_output=True,text=True,check=True)
count=len(set(result.stdout.splitlines()))
with open('seed-transfers.jsonl','a') as out:out.write(json.dumps({'objects':count,'refs':[v[2] for v in updates]})+'\\n')
if count>24:
 print('artifacts_git_receive_pack_service_unavailable: fixture object budget',file=sys.stderr);sys.exit(1)
`);await chmod(hook,0o700);
  const lostRefHook=destination+'/hooks/post-receive';await writeFile(lostRefHook,"#!/bin/sh\nif [ $(wc -l < seed-transfers.jsonl) -eq 2 ]; then git update-ref -d refs/tags/v05; fi\n");await chmod(lostRefHook,0o700);
  const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:token,SQUALI_JOB_LEASE:lease,SQUALI_ALLOW_TEST_HTTP:'1',SQUALI_GIT_SEED_OBJECT_CAP:'24',GIT_CURL_VERBOSE:'1'};
  const args=['scripts/import-source.py','seed',native,'--state',server.dir+'/state'];const result=await exec('python3',args,{env,timeout:45000,maxBuffer:1024*1024}).then(r=>({code:0,...r}),e=>e);
  assert.equal(result.code,1,'A vanished earlier seed ref must stop the import');assert.equal((await readFile(destination+'/seed-transfers.jsonl','utf8')).trim().split('\n').length,2,'Reconcile earlier acknowledged refs before another transfer');const sourceUsage=await server.sql`SELECT * FROM weave_source_usage ORDER BY kind`;await unlink(lostRefHook);await exec('python3',args,{env,timeout:45000,maxBuffer:1024*1024});assert.deepEqual(await server.sql`SELECT * FROM weave_source_usage ORDER BY kind`,sourceUsage);const state=JSON.parse(await readFile(server.dir+'/state/state.json','utf8'));assert.equal(state.complete,true);
  const transfers=(await readFile(destination+'/seed-transfers.jsonl','utf8')).trim().split('\n').map(v=>JSON.parse(v));assert.ok(transfers.length>1&&transfers.length<=8);assert.ok(transfers.every(v=>v.objects<=24));
  const expected=(await git('for-each-ref','--format=%(refname) %(objectname)')).split('\n').sort();const actual=(await exec('git',['--git-dir',destination,'for-each-ref','--format=%(refname) %(objectname)'])).stdout.trim().split('\n').sort();assert.deepEqual(actual,expected);
  assert.deepEqual((await exec('git',['--git-dir',destination,'rev-list','--objects','--all','--no-object-names'])).stdout.trim().split('\n').sort(),(await git('rev-list','--objects','--all','--no-object-names')).split('\n').sort());await exec('git',['--git-dir',destination,'fsck','--full']);
  const usage=await server.sql`SELECT * FROM weave_usage`;const replay=await exec('python3',args,{env});assert.equal(JSON.parse(replay.stdout).reused,true);assert.deepEqual(await server.sql`SELECT * FROM weave_usage`,usage);
  assert.ok(!(await readFile(server.dir+'/state/state.json','utf8')).includes(token));
  console.log(JSON.stringify({command:'node --import tsx --test tests/native-seed.test.ts',sourceCommits:30,refs:7,gitTransfers:transfers.length,maxNewObjects:Math.max(...transfers.map(v=>v.objects)),nativeFsck:true,fullObjectEquality:true,completedReplayCalls:0,stopsAfterEarlierRefDisappears:true,explicitSameJournalRecovery:true}));
 }finally{await server.close();}
});

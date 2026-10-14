import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);

test('bounded resumable indexing serves deep history through HTTP without rereading Git objects',async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,onQuery:()=>queries++});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'graph',name:'Deep graph'});assert.equal(p.status,201);
  const repo=join(server.dir,'weave-graph.git');
  // Native Git creates the independent fixture, including a branch from old history.
  let data='blob\nmark :10000\ndata 7\nstable\n\n';
  for(let i=1;i<=1024;i++)data+=`commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1700000000+i} +0000\ndata ${Buffer.byteLength('commit '+i)}\ncommit ${i}\n${i>1?'from :'+(i-1)+'\n':''}${i%8===0?'merge :'+(i-2)+'\n':''}M 100644 :10000 stable.txt\n\n`;
  data+='commit refs/heads/alternative\nmark :2000\ncommitter Fixture <fixture@example.invalid> 1700002000 +0000\ndata 11\nalternative\nfrom :512\nM 100644 :10000 stable.txt\n\n';
  const importer=spawn('git',['--git-dir',repo,'fast-import','--quiet','--force']);let stderr='';importer.stderr.on('data',c=>stderr+=c);importer.stdin.end(data);await new Promise<void>((resolve,reject)=>importer.on('close',code=>code===0?resolve():reject(Error(stderr))));
  const git=async(...args:string[])=>(await exec('git',['--git-dir',repo,...args])).stdout.trim();
  const head=await git('rev-parse','main'),fork=await git('rev-parse','alternative'),root=await git('rev-list','--max-parents=0','main'),base=await git('merge-base',head,fork);
  const ids=(await git('rev-list','--topo-order','main')).split('\n');
  const batch=spawn('git',['--git-dir',repo,'cat-file','--batch']);const output:Buffer[]=[];batch.stdout.on('data',c=>output.push(c));batch.stderr.resume();batch.stdin.end(ids.join('\n')+'\n');await new Promise<void>((done,fail)=>batch.on('close',code=>code===0?done():fail(Error('Native commit export failed'))));
  const bytes=Buffer.concat(output),records:{oid:string;body:string}[]=[];let offset=0;
  while(offset<bytes.length){const end=bytes.indexOf(10,offset);const [oid,type,size]=bytes.subarray(offset,end).toString().split(' ');assert.equal(type,'commit');offset=end+1;records.push({oid,body:bytes.subarray(offset,offset+Number(size)).toString('base64')});offset+=Number(size)+1;}
  const beforeUpload=(await call('/usage')).body.attempts;
  for(let at=0;at<records.length;at+=128){const uploaded=await call('/projects/graph/index/commits',{ref:head,commits:records.slice(at,at+128)});assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));assert.equal(uploaded.body.accepted,Math.min(128,records.length-at));}
  assert.equal((await call('/usage')).body.attempts-beforeUpload,1,'Bulk index anchors to one provider commit, then verifies Git hashes and parent links');
  assert.equal((await call('/projects/graph/index/commits',{ref:head,commits:[records[0]]})).body.accepted,0,'Duplicate uploads reuse persisted commits');
  assert.equal((await call('/projects/graph/index/commits',{ref:head,commits:[{...records[0],body:Buffer.from('forged').toString('base64')}]})).status,400);
  let steps=0,last:any;
  do {last=await call('/projects/graph/index',{ref:head,limit:64});assert.equal(last.status,200,JSON.stringify(last.body));assert.ok(last.body.reads<=64);steps++;assert.ok(steps<=48,'Index must finish within a finite call budget');}while(!last.body.complete);
  assert.ok(steps>1,'Large indexing is explicitly resumable');
  assert.equal((await call('/projects/graph/index',{ref:fork,limit:64})).body.complete,true);
  const before=(await call('/usage')).body.attempts;
  const mainlineQueries:number[]=[];
  for(const [left,right]of [[root,head],[head,root]]){queries=0;const result=await call('/projects/graph/merge-base',{left,right});assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.bases,[root]);mainlineQueries.push(queries);assert.ok(queries<=32,`A cold mainline merge-base must use the index; observed ${queries} SQL statements`);}
  console.log(JSON.stringify({mainlineMergeBaseSql:mainlineQueries,commits:1024}));
  queries=0;assert.equal((await call('/projects/graph/ancestry',{ancestor:root,descendant:head})).body.isAncestor,true);const mainlineAncestrySql=queries;assert.ok(queries<=32,`A mainline ancestry query through merges must use the index; observed ${queries} SQL statements`);console.log(JSON.stringify({mainlineAncestrySql,nativeMergeCommits:128}));
  assert.equal((await call('/projects/graph/ancestry',{ancestor:fork,descendant:head})).body.isAncestor,false);
  const merge=await call('/projects/graph/merge-base',{left:head,right:fork});assert.equal(merge.status,200,JSON.stringify(merge.body));assert.deepEqual(merge.body.bases,[base]);
  const bisect=await call('/projects/graph/bisect',{good:root,bad:head});assert.equal(bisect.status,200,JSON.stringify(bisect.body));assert.equal(bisect.body.remaining,1023);assert.equal(bisect.body.candidate,await git('rev-parse','main~511'));
  assert.equal((await call('/usage')).body.attempts,before,'New indexed graph queries do not reread provider objects');
  const repeated=await call('/projects/graph/index',{ref:head,limit:64});assert.equal(repeated.body.complete,true);assert.equal(repeated.body.reads,0);
  const history=await call('/projects/graph/path-history?ref='+head+'&path=stable.txt');assert.equal(history.status,200,JSON.stringify(history.body));assert.deepEqual(history.body.commits.map((c:any)=>c.oid),[root]);assert.equal(history.body.next,null,'Unchanged tree spans should not require empty history pages');
  const blame=await call('/projects/graph/blame?ref='+head+'&path=stable.txt');assert.equal(blame.status,200,JSON.stringify(blame.body));assert.deepEqual(blame.body.lines.map((line:any)=>line.commit),[root]);
  console.log(JSON.stringify({command:'node --import tsx --test tests/graph.test.ts',commits:1025,steps,mergeBase:base,newQueryProviderReads:0}));
 }finally{await server.close();}
});

test('native-repository index CLI uploads verified metadata with an explicit finite step budget',async()=>{
 const server=await startLocal({port:0,test:true});
 try{
  const p=await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'index-cli',name:'Index CLI',files:[{path:'file.txt',content:'indexed\n'}]})}).then(r=>r.json()) as any;
  const run=()=>exec('node',['scripts/index-repository.mjs','index-cli',join(server.dir,'weave-index-cli.git'),p.head,'--max-steps','2'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  const first=JSON.parse((await run()).stdout);assert.equal(first.complete,true);assert.equal(first.accepted,1);assert.equal(first.sourceCommits,1);assert.ok(first.steps<=2);
  const second=JSON.parse((await run()).stdout);assert.equal(second.complete,true);assert.equal(second.skipped,true);
  console.log(JSON.stringify({command:'node --import tsx --test tests/graph.test.ts',nativeIndexCLI:true,finiteStepBudget:2,completedIndexReused:true}));
 }finally{await server.close();}
});

test('index progress survives a server restart and preserves criss-cross merge bases',async()=>{
 let server=await startLocal({port:0,test:true});
 const call=async(path:string,body?:unknown,token='local-admin-test-token')=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'cross',name:'Criss cross',files:[{path:'file.txt',content:'same\n'}]});assert.equal(p.status,201);const repo=join(server.dir,'weave-cross.git');
  const git=async(...args:string[])=>(await exec('git',['--git-dir',repo,...args],{env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})).stdout.trim();
  const tree=await git('rev-parse','main^{tree}');
  const commit=(message:string,...parents:string[])=>git('commit-tree',tree,'-m',message,...parents.flatMap(p=>['-p',p]));
  const a=await commit('A',p.body.head),b=await commit('B',p.body.head),left=await commit('left',a,b),right=await commit('right',b,a),unrelated=await commit('unrelated');
  const unrelatedRaw=await exec('git',['--git-dir',repo,'cat-file','commit',unrelated],{encoding:'buffer'});
  const unlinked=await call('/projects/cross/index/commits',{ref:p.body.head,commits:[{oid:unrelated,body:unrelatedRaw.stdout.toString('base64')}]});assert.equal(unlinked.status,400);assert.equal(unlinked.body.error,'index_unreachable');
  const expected=(await git('merge-base','--all',left,right)).split('\n').sort();assert.equal(expected.length,2);
  assert.equal((await call('/projects/cross/index',{ref:left,limit:1})).body.complete,false);
  let progress=await call('/projects/cross/index?ref='+left);assert.equal(progress.status,200,JSON.stringify(progress.body));assert.equal(progress.body.complete,false);assert.ok(progress.body.pending>0);
  const directory=server.dir;await server.close();server=await startLocal({port:0,test:true,directory});
  progress=await call('/projects/cross/index?ref='+left);assert.equal(progress.body.complete,false);
  for(const ref of [left,right,unrelated]){const result=await call('/projects/cross/index',{ref,limit:64});assert.equal(result.body.complete,true,JSON.stringify(result.body));}
  assert.deepEqual((await call('/projects/cross/merge-base',{left,right})).body.bases,expected);
  assert.deepEqual((await call('/projects/cross/merge-base',{left,right:left})).body.bases,[left]);
  assert.deepEqual((await call('/projects/cross/merge-base',{left,right:unrelated})).body.bases,[]);
  assert.equal((await call('/projects/cross/ancestry',{ancestor:b,descendant:left})).body.isAncestor,true,'Second-parent ancestry is retained');
  assert.equal((await call('/projects/cross/bisect',{good:b,bad:left})).status,409,'Bisect explicitly retains first-parent semantics');
  assert.equal((await call('/projects/cross/index',{ref:left,limit:129})).status,400);
  assert.equal((await call('/projects/cross/index',{ref:left},'local-agent-test-token')).status,403);
  assert.equal((await call('/projects/cross/index?ref='+left,undefined,'local-agent-test-token')).status,403);
  assert.equal((await call('/projects/cross/index',{ref:'0'.repeat(40)})).status,404);
  console.log(JSON.stringify({command:'node --import tsx --test tests/graph.test.ts',restartResume:true,crissCrossBases:expected,disconnected:true,secondParent:true,nonAdminIndexDenied:true}));
 }finally{await server.close();}
});

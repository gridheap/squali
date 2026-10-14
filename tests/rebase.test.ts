import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);

test('server rebase preserves independent changes and matches native Git without moving main or inheriting approval',async()=>{
 const server=await startLocal({port:0,test:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const lines=Array.from({length:12},(_,i)=>'line '+i),original=lines.join('\n')+'\n';
  const p=(await call('/projects',{id:'rebasing',name:'Rebase',files:[{path:'src/text.txt',content:original},{path:'run.sh',content:'echo before\n'},{path:'obsolete.txt',content:'remove\n'}]})).body;
  const sourceLines=[...lines];sourceLines[10]='incoming';const ontoLines=[...lines];ontoLines[0]='upstream';
  const source=(await call('/projects/rebasing/changes',{id:'source',title:'Original source',intent:'Rebase a commit',base:p.head,files:[{path:'src/text.txt',content:sourceLines.join('\n')+'\n'},{path:'run.sh',content:'echo after\n'},{path:'new.txt',content:'new\n'},{path:'obsolete.txt',content:null}]})).body;
  const onto=(await call('/projects/rebasing/changes',{id:'onto',title:'Target',intent:'Advance independently',base:p.head,files:[{path:'src/text.txt',content:ontoLines.join('\n')+'\n'},{path:'run.sh',content:'echo before\n',mode:'100755'},{path:'keep.txt',content:'keep\n'}]})).body;
  await call('/projects/rebasing/changes/source/review',{decision:'approved'});
  const request={id:'rebased',commit:source.oid,onto:onto.oid,note:'Keep upstream changes'};
  const result=await call('/projects/rebasing/rebase',request);assert.equal(result.status,201,JSON.stringify(result.body));const rebased=result.body;
  assert.equal(rebased.base,onto.oid);assert.equal(rebased.status,'proposed');assert.equal(rebased.reviewer,null);assert.equal(rebased.context.rebase.commit,source.oid);
  assert.equal((await call('/projects/rebasing')).body.head,p.head,'Rebase cannot move main');
  assert.deepEqual((await call('/projects/rebasing/commit?ref='+rebased.oid)).body.parents,[onto.oid]);
  const copy=server.dir+'/native-rebase';await exec('git',['clone',p.remote,copy]);await exec('git',['-C',copy,'checkout','--detach',onto.oid]);
  await exec('git',['-C',copy,'-c','user.name=Verifier','-c','user.email=verify@example.invalid','cherry-pick',source.oid]);
  const tree=(await exec('git',['-C',copy,'rev-parse','HEAD^{tree}'])).stdout.trim();assert.equal((await call('/projects/rebasing/commit?ref='+rebased.oid)).body.tree,tree);await exec('git',['-C',copy,'fsck','--full']);
  const cli=await new Promise<string>((resolve,reject)=>{const child=spawn('node',['scripts/squali.mjs','rebase','rebasing'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('close',code=>code===0?resolve(out):reject(Error(err)));child.stdin.end(JSON.stringify(request));});assert.equal(JSON.parse(cli).oid,rebased.oid);
  assert.equal((await call('/projects/rebasing/rebase',request)).body.oid,rebased.oid);
  assert.equal((await call('/projects/rebasing/rebase',{...request,onto:p.head})).status,409);
  await call('/projects/rebasing/changes/onto/review',{decision:'approved'});assert.equal((await call('/projects/rebasing/publish',{id:'land-onto',changes:['onto']})).status,201);
  assert.equal((await call('/projects/rebasing/rebase',request)).body.oid,rebased.oid,'Retry retains explicit target after main moves');
  assert.equal((await call('/projects/rebasing/publish',{id:'unreviewed',changes:['rebased']})).status,409);
  await call('/projects/rebasing/changes/rebased/review',{decision:'approved'});assert.equal((await call('/projects/rebasing/publish',{id:'land-rebase',changes:['rebased']})).status,201);
  const file=(await call('/projects/rebasing/file?path=run.sh')).body;assert.equal(file.content,'echo after\n');assert.equal(file.mode,'100755');assert.equal((await call('/projects/rebasing/file?path=obsolete.txt')).status,404);
  console.log(JSON.stringify({command:'node --import tsx --test tests/rebase.test.ts',nativeGitTree:tree,mainUnchangedByRebase:true,freshReview:true,repeatOid:rebased.oid}));
 }finally{await server.close();}
});

test('rebase returns recoverable conflicts, rejects unrelated resolutions and requires an explicit merge parent',async()=>{
 const server=await startLocal({port:0,test:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const root=(await call('/projects',{id:'conflicted',name:'Conflicts',files:[{path:'value.txt',content:'base\n'},{path:'gone.txt',content:'base\n'}]})).body.head;
  const source=(await call('/projects/conflicted/changes',{id:'source',title:'Source',intent:'Source',base:root,files:[{path:'value.txt',content:'incoming\n'},{path:'gone.txt',content:null},{path:'added.txt',content:'incoming\n'}]})).body;
  const target=(await call('/projects/conflicted/changes',{id:'target',title:'Target',intent:'Target',base:root,files:[{path:'value.txt',content:'target\n'},{path:'gone.txt',content:'edited\n'},{path:'added.txt',content:'target\n'}]})).body;
  const request={id:'resolved',commit:source.oid,onto:target.oid};const conflict=await call('/projects/conflicted/rebase',request);assert.equal(conflict.status,409,JSON.stringify(conflict.body));assert.equal(conflict.body.error,'rebase_conflict');assert.deepEqual(conflict.body.details.conflicts.map((c:any)=>c.path).sort(),['added.txt','gone.txt','value.txt']);assert.equal(conflict.body.details.conflicts.find((c:any)=>c.path==='value.txt').target,'target\n');
  assert.equal((await call('/projects/conflicted/changes/resolved')).status,404);assert.equal((await call('/projects/conflicted')).body.head,root);
  assert.equal((await call('/projects/conflicted/rebase',{...request,resolutions:[{path:'outside.txt',content:'escape'}]})).status,400);
  assert.equal((await call('/projects/conflicted/rebase',{...request,resolutions:[{path:'value.txt',content:'resolved\n'}]})).status,409);
  const resolutions=[{path:'value.txt',content:'resolved\n'},{path:'gone.txt',content:null},{path:'added.txt',content:'keep both\n'}];
  const resolved=await call('/projects/conflicted/rebase',{...request,resolutions});assert.equal(resolved.status,201,JSON.stringify(resolved.body));assert.equal(resolved.body.status,'proposed');assert.equal((await call('/projects/conflicted/file?path=value.txt&ref='+resolved.body.oid)).body.content,'resolved\n');
  await call('/projects/conflicted/changes/target/review',{decision:'approved'});const merge=(await call('/projects/conflicted/publish',{id:'target-land',changes:['target']})).body.oid;
  const ambiguous=await call('/projects/conflicted/rebase',{id:'merge-rebase',commit:merge,onto:root});assert.equal(ambiguous.status,400);assert.equal(ambiguous.body.error,'rebase_parent');
  assert.equal((await call('/projects/conflicted/rebase',{id:'merge-rebase',commit:merge,onto:root,parent:1})).status,201);
  assert.equal((await call('/projects/conflicted/rebase',{id:'bad-parent',commit:source.oid,onto:root,parent:2})).status,400);
  assert.equal((await call('/projects/conflicted/rebase',{id:'missing',commit:source.oid,onto:'f'.repeat(40)})).status,404);
  assert.equal((await call('/projects/conflicted/rebase',{id:'invalid',commit:source.oid,onto:'main'})).status,400);
  const collisionSource=(await call('/projects/conflicted/changes',{id:'collision-source',title:'Collision',intent:'Add file',base:root,files:[{path:'collision.txt',content:'file'}]})).body;
  const collisionTarget=(await call('/projects/conflicted/changes',{id:'collision-target',title:'Collision',intent:'Add directory',base:root,files:[{path:'collision.txt/child',content:'directory'}]})).body;
  assert.equal((await call('/projects/conflicted/rebase',{id:'collision',commit:collisionSource.oid,onto:collisionTarget.oid})).status,422);
  assert.equal((await call('/projects/conflicted/changes/collision')).status,404);
  console.log(JSON.stringify({command:'node --import tsx --test tests/rebase.test.ts',conflictPaths:3,explicitResolutions:true,explicitMergeParent:true}));
 }finally{await server.close();}
});

test('rebase bounds aggregate conflict bytes before returning large target contents',async()=>{
 const server=await startLocal({port:0,test:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const paths=Array.from({length:15},(_,i)=>'file-'+i+'.txt');
  const root=(await call('/projects',{id:'bounded-rebase',name:'Bounded rebase',files:paths.map(path=>({path,content:'base\n'}))})).body.head;
  const source=(await call('/projects/bounded-rebase/changes',{id:'source',title:'Source',intent:'Source',base:root,files:paths.map(path=>({path,content:'incoming\n'}))})).body.oid;
  let onto=root;for(let i=0;i<3;i++){const target=await call('/projects/bounded-rebase/changes',{id:'target-'+i,title:'Target',intent:'Large conflict fixture',base:onto,files:paths.slice(i*5,(i+1)*5).map(path=>({path,content:'x'.repeat(200*1024)}))});assert.equal(target.status,201);onto=target.body.oid;}
  const result=await call('/projects/bounded-rebase/rebase',{id:'excessive',commit:source,onto});assert.equal(result.status,413,JSON.stringify({status:result.status,error:result.body.error}));assert.equal(result.body.error,'rebase_size');assert.equal((await call('/projects/bounded-rebase/changes/excessive')).status,404);
  console.log(JSON.stringify({command:'node --import tsx --test tests/rebase.test.ts',aggregateConflictBytesBounded:true,proposalCreated:false}));
 }finally{await server.close();}
});

test('continuous rebase checkpoints a branch, resumes conflicts and matches native Git',async()=>{
 let server=await startLocal({port:0,test:true,source:true,poolSize:1});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{signal:AbortSignal.timeout(3000),method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const project=(await call('/projects',{id:'series',name:'Continuous rebase',files:[{path:'a',content:'root\n'},{path:'b',content:'root\n'}]})).body;
  let base=project.head;const commits=[];for(const [i,path] of ['a','b','new'].entries()){const c=await call('/projects/series/changes',{id:'original-'+i,title:'Commit '+i,intent:'Branch fixture',base,files:[{path,content:'branch-'+i+'\n'}]});assert.equal(c.status,201);commits.push(c.body.oid);base=c.body.oid;}
  const onto=(await call('/projects/series/changes',{id:'upstream',title:'Upstream',intent:'Independent target',base:project.head,files:[{path:'extra',content:'upstream\n'}]})).body.oid;
  const request={id:'continuous',commits,onto,limit:1};const first=await call('/projects/series/rebase-series',request);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.state,'running');assert.equal(first.body.completed,1);
  const dir=server.dir;await server.close();server=await startLocal({port:0,test:true,source:true,poolSize:1,directory:dir});
  const second=await call('/projects/series/rebase-series',request);assert.equal(second.body.completed,2);assert.equal(second.body.changes[0].oid,first.body.changes[0].oid);
  const done=await call('/projects/series/rebase-series',request);assert.equal(done.body.state,'complete');assert.equal(done.body.completed,3);assert.equal((await call('/projects/series')).body.head,project.head);
  for(const change of done.body.changes){assert.equal((await call('/projects/series/changes/'+change.id)).body.status,'proposed');}
  const {writeFile}=await import('node:fs/promises');const copy=server.dir+'/native-series';await exec('git',['init','--initial-branch=main',copy]);const git=async(...args:string[])=>(await exec('git',['-C',copy,'-c','user.name=Verifier','-c','user.email=v@example.invalid',...args])).stdout.trim();await writeFile(copy+'/a','root\n');await writeFile(copy+'/b','root\n');await git('add','.');await git('commit','-m','Root');const nativeRoot=await git('rev-parse','HEAD'),nativeCommits=[];for(const [i,path] of ['a','b','new'].entries()){await writeFile(copy+'/'+path,'branch-'+i+'\n');await git('add','.');await git('commit','-m','Step '+i);nativeCommits.push(await git('rev-parse','HEAD'));}await git('checkout','--detach',nativeRoot);await writeFile(copy+'/extra','upstream\n');await git('add','.');await git('commit','-m','Upstream');await git('cherry-pick',...nativeCommits);const tree=(await exec('git',['-C',copy,'rev-parse','HEAD^{tree}'])).stdout.trim();assert.equal((await call('/projects/series/commit?ref='+done.body.head)).body.tree,tree);
  assert.deepEqual((await call('/projects/series/rebase-series',request)).body,done.body);assert.equal((await call('/projects/series/rebase-series',{...request,onto:project.head})).status,409);
  const conflictOnto=(await call('/projects/series/changes',{id:'conflict-upstream',title:'Conflict',intent:'Conflict',base:project.head,files:[{path:'a',content:'target\n'}]})).body.oid;
  const blockedRequest={id:'blocked',commits,onto:conflictOnto};const blocked=await call('/projects/series/rebase-series',blockedRequest);assert.equal(blocked.body.state,'blocked');assert.equal(blocked.body.completed,0);assert.equal(blocked.body.conflicts[0].path,'a');
  const resolved=await call('/projects/series/rebase-series',{...blockedRequest,resolutions:{[commits[0]]:[{path:'a',content:'resolved\n'}]}});assert.equal(resolved.body.state,'complete',JSON.stringify(resolved.body));assert.equal((await call('/projects/series/file?path=a&ref='+resolved.body.head)).body.content,'resolved\n');
  assert.equal((await call('/projects/series/rebase-series',{id:'nonlinear',commits:[commits[1],commits[0]],onto})).status,400);
  console.log(JSON.stringify({command:'node --import tsx --test tests/rebase.test.ts',sourceAuthority:true,continuousCommits:3,nativeTree:tree,processRestart:true,conflictResume:true,freshReviewRequired:true}));
 }finally{await server.close();}
});

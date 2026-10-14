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

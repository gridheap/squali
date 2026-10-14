import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {startLocal} from '../scripts/local.ts';const exec=promisify(execFile);
test('source Git bridge clones published history, hides proposals and incrementally fetches reviewed publication',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:1});const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{signal:AbortSignal.timeout(3000),method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'git-source',name:'Source Git compatibility',files:[{path:'README.md',content:'Published\n'}]});assert.equal(p.body.storage,'source');
  const hidden=(await call('/projects/git-source/changes',{id:'hidden',title:'Hidden draft',intent:'Do not export unpublished drafts',files:[{path:'private-draft.md',content:'Draft only\n'}]})).body;
  const copy=server.dir+'/native-clone';const git=async(args:string[])=>exec('git',['-c','http.extraHeader=Authorization: Bearer local-admin-test-token',...args],{timeout:3000});
  await git(['clone',server.url+'/api/projects/git-source/git',copy]);await exec('git',['-C',copy,'fsck','--full']);assert.equal((await exec('git',['-C',copy,'rev-parse','HEAD'])).stdout.trim(),p.body.head);await assert.rejects(exec('git',['-C',copy,'cat-file','-e',hidden.oid]));
  const usage=(await call('/usage')).body.source;await git(['-C',copy,'fetch']);assert.deepEqual((await call('/usage')).body.source,usage,'Repeated fetch reads no source blobs');
  await call('/projects/git-source/changes/hidden/review',{decision:'approved'});const published=await call('/projects/git-source/publish',{id:'land',changes:['hidden']});assert.equal(published.status,201);
  await git(['-C',copy,'fetch']);await exec('git',['-C',copy,'reset','--hard','origin/main']);assert.equal((await exec('git',['-C',copy,'rev-parse','HEAD'])).stdout.trim(),published.body.oid);assert.equal((await exec('git',['-C',copy,'show','HEAD:private-draft.md'])).stdout,'Draft only\n');await exec('git',['-C',copy,'fsck','--full']);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source-git.test.ts',nativeClone:true,incrementalFetch:true,unpublishedObjectsExcluded:true,repeatedFetchNewSourceReads:0}));
 }finally{await server.close();}
});

test('Git bridge reconciles lost push acknowledgements and rebuilds a deleted derived repository',async()=>{
 let lose=true;const server=await startLocal({port:0,test:true,source:true,poolSize:1,onImportPushed:async()=>{if(lose){lose=false;throw Error('Lost export acknowledgement');}}});const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const api=async(path:string,body?:unknown)=>fetch(server.url+'/api'+path,{signal:AbortSignal.timeout(3000),method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
 try{await api('/projects',{id:'export-recovery',name:'Recoverable export',files:[{path:'file',content:'Durable source\n'}]});const endpoint='/projects/export-recovery/git/info/refs?service=git-upload-pack';const failed=await api(endpoint);assert.equal(failed.status,500);await failed.body?.cancel();const usage=await api('/usage').then(r=>r.json()) as any;const recovered=await api(endpoint);assert.equal(recovered.status,200);await recovered.body?.cancel();assert.deepEqual((await api('/usage').then(r=>r.json()) as any).source,usage.source);
  const {rm}=await import('node:fs/promises');await rm(server.dir+'/weave-export-recovery.git',{recursive:true});assert.equal((await api('/projects/export-recovery/file?path=file').then(r=>r.json()) as any).content,'Durable source\n');const rebuilt=await api(endpoint);assert.equal(rebuilt.status,200);await rebuilt.body?.cancel();const copy=server.dir+'/recovered-git';await exec('git',['-c','http.extraHeader=Authorization: Bearer local-admin-test-token','clone',server.url+'/api/projects/export-recovery/git',copy]);await exec('git',['-C',copy,'fsck','--full']);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source-git.test.ts',lostAckReconciled:true,lostAckExtraSourceReads:0,derivedRepositoryDeleted:true,rebuildVerifiedByGit:true}));
 }finally{await server.close();}
});

test('source Git exports allocate separate provider repositories per workspace',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:1});const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 try{for(const id of ['first-export','second-export']){await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id,name:id,files:[{path:'name',content:id}]})});const copy=server.dir+'/'+id;await exec('git',['-c','http.extraHeader=Authorization: Bearer local-admin-test-token','clone',server.url+'/api/projects/'+id+'/git',copy]);assert.equal((await exec('git',['-C',copy,'show','HEAD:name'])).stdout,id);}
 }finally{await server.close();}
});

test('one slow Git export leaves database capacity for another workspace and rejects duplicate export',async()=>{
 let entered:()=>void=()=>{},release:()=>void=()=>{};const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let first=true;
 const server=await startLocal({port:0,test:true,source:true,poolSize:1,onImportPushed:async()=>{if(first){first=false;entered();await gate;}}}),headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const call=(path:string,body?:unknown)=>fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(4000)});
 try{for(const id of ['slow-export','parallel-export'])assert.equal((await call('/projects',{id,name:id,files:[{path:'file',content:id}]})).status,201);
  const pending=call('/projects/slow-export/git/info/refs?service=git-upload-pack');await Promise.race([waiting,pending.then(()=>{throw Error('Expected a held export');})]);
  assert.equal((await call('/projects/slow-export/git/info/refs?service=git-upload-pack')).status,409);
  const independent=await call('/projects/parallel-export/git/info/refs?service=git-upload-pack');assert.equal(independent.status,200);await independent.body?.cancel();release();const finished=await pending;assert.equal(finished.status,200);await finished.body?.cancel();
 }finally{release();await server.close();}
});

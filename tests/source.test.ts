import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

test('source changesets persist first-parent deltas and blobs without proposal refs, then publish through CAS',async()=>{
 let server=await startLocal({port:0,test:true,source:true});
 const call=async(path:string,body?:unknown,token='local-admin-test-token')=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'source',name:'Source authority',files:[{path:'src/a.txt',content:'original\n'},{path:'remove.txt',content:'old\n'},{path:'run.sh',content:'echo ok\n',mode:'100755'}]});assert.equal(p.status,201,JSON.stringify(p.body));assert.equal(p.body.storage,'source');
  const initial=(await call('/projects/source/changesets/'+p.body.head)).body;assert.match(initial.id,/^[a-f0-9]{64}$/);assert.deepEqual(initial.parents,[]);assert.equal(initial.files.length,3);assert.equal(initial.tree,undefined,'The authoritative changeset is a delta, not a tree pointer');
  const request={id:'independent',title:'Delta',intent:'Change without moving a ref',base:p.body.head,files:[{path:'src/a.txt',content:'changed\n'},{path:'remove.txt',content:null},{path:'run.sh',content:'echo ok\n',mode:'100644'}]};
  const proposal=await call('/projects/source/changes',request,'local-agent-test-token');assert.equal(proposal.status,201,JSON.stringify(proposal.body));
  const change=(await call('/projects/source/changesets/'+proposal.body.oid)).body;assert.deepEqual(change.parents,[initial.id]);assert.deepEqual(change.files.map((f:any)=>f.path),['remove.txt','run.sh','src/a.txt']);assert.equal(change.files[0].blob,null);assert.equal(change.files[1].mode,'100644');assert.match(change.files[2].blob,/^[a-f0-9]{64}$/);
  const state=(await call('/projects/source/source')).body;assert.equal(state.refs.length,1);assert.equal(state.refs[0].oid,p.body.head);assert.equal(state.changesets,2);
  assert.equal((await call('/projects/source/file?path=src/a.txt&ref='+proposal.body.oid)).body.content,'changed\n');
  const usage=(await call('/usage')).body;assert.equal(usage.attempts,0,'Source changesets never need Artifacts proposal refs');
  assert.equal((await call('/projects/source/changes',request,'local-agent-test-token')).body.oid,proposal.body.oid);assert.deepEqual((await call('/usage')).body.source,usage.source,'Replay reuses stored immutable data');
  const dir=server.dir;await server.close();server=await startLocal({port:0,test:true,source:true,directory:dir});
  assert.equal((await call('/projects/source/file?path=src/a.txt&ref='+proposal.body.oid)).body.content,'changed\n');
  assert.equal((await call('/projects/source/publish',{id:'no-review',changes:['independent']})).status,409);
  await call('/projects/source/changes/independent/review',{decision:'approved'});const published=await call('/projects/source/publish',{id:'publish',changes:['independent'],expectedHead:p.body.head});assert.equal(published.status,201,JSON.stringify(published.body));
  assert.equal((await call('/projects/source/file?path=src/a.txt')).body.content,'changed\n');assert.equal((await call('/projects/source/file?path=remove.txt')).status,404);assert.equal((await call('/projects/source/file?path=run.sh')).body.mode,'100644');
  assert.equal((await call('/projects/source/source')).body.refs.length,1);assert.equal((await call('/usage')).body.attempts,0);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',durableChangesets:true,independentR2Blobs:true,proposalRefs:0,artifactsCalls:0,processRestart:true,publication:published.body.oid}));
 }finally{await server.close();}
});

test('resumable source import preserves native history, tags and binary bytes and rejects incomplete or forged objects',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,mkdir}=await import('node:fs/promises');const {gzipSync}=await import('node:zlib');const exec=promisify(execFile);
 const server=await startLocal({port:0,test:true,source:true});const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const repo=server.dir+'/native-source';await exec('git',['init','--initial-branch=main',repo]);const git=async(...args:string[])=>(await exec('git',['-C',repo,...args])).stdout.trim();await git('config','user.name','Source');await git('config','user.email','source@example.invalid');
  await mkdir(repo+'/src');await writeFile(repo+'/src/value.txt','first\n');await git('add','.');await git('commit','-m','First');const first=await git('rev-parse','HEAD');
  const binary=Buffer.from([0,1,2,255,254,128]);await writeFile(repo+'/image.bin',binary);await writeFile(repo+'/src/value.txt','second\n');await git('add','.');await git('commit','-m','Second');await git('tag','-a','v1','-m','Release');const head=await git('rev-parse','HEAD');
  const p=await call('/projects',{id:'imported',name:'Imported',storage:'source',import:true,files:[]});assert.equal(p.status,201);assert.equal(p.body.state,'importing');assert.equal((await call('/projects/imported/file?path=src/value.txt')).status,409);
  const ids=(await git('rev-list','--objects','--all','--no-object-names')).split('\n');const refs=(await git('for-each-ref','--format=%(refname) %(objectname)','refs/heads','refs/tags')).split('\n').map(line=>{const [name,oid]=line.split(' ');return {name,oid};});
  assert.equal((await call('/projects/imported/source/finish',{refs,defaultBranch:'main'})).status,409);
  const objects=[];for(const oid of ids){const type=await git('cat-file','-t',oid);const data=(await exec('git',['-C',repo,'cat-file',type,oid],{encoding:'buffer'})).stdout;objects.push({oid,type,encoding:'gzip',body:gzipSync(data).toString('base64')});}
  const corrupt=await call('/projects/imported/source/objects',{objects:[{...objects[0],body:gzipSync(Buffer.from('forged')).toString('base64')}]});assert.equal(corrupt.status,400);assert.equal((await call('/usage')).body.source.writes,0);
  assert.deepEqual((await call('/projects/imported/source/missing',{oids:ids})).body.missing.sort(),ids.sort());
  const uploaded=await call('/projects/imported/source/objects',{objects});assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));assert.equal(uploaded.body.accepted,ids.length);
  const usage=(await call('/usage')).body.source;assert.equal((await call('/projects/imported/source/objects',{objects})).body.accepted,0);assert.deepEqual((await call('/usage')).body.source,usage);
  assert.deepEqual((await call('/projects/imported/source/missing',{oids:ids})).body.missing,[]);assert.equal((await call('/projects/imported/source/changesets',{commits:[head]})).status,404,'A child cannot be sealed before its parent');
  assert.equal((await call('/projects/imported/source/changesets',{commits:[first,head]})).status,200);const done=await call('/projects/imported/source/finish',{refs,defaultBranch:'main'});assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.state,'ready');
  assert.equal((await call('/projects/imported/index?ref='+head)).body.complete,true,'A native source import eagerly completes its graph index');assert.equal((await call('/projects/imported/ancestry',{ancestor:first,descendant:head})).body.isAncestor,true);
  assert.equal((await call('/projects/imported/file?path=src/value.txt')).body.content,'second\n');assert.equal((await call('/projects/imported/commit?ref='+head)).body.parents[0],first);assert.deepEqual((await call('/projects/imported/source')).body.refs,refs);
  const raw=await fetch(server.url+'/api/projects/imported/blob?ref='+head+'&path=image.bin',{headers:{authorization:'Bearer local-admin-test-token'}});assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),binary);
  assert.equal((await call('/projects/imported/source/finish',{refs,defaultBranch:'main'})).status,200);assert.equal((await call('/projects/imported/source/finish',{refs:[{name:'refs/heads/main',oid:first}],defaultBranch:'main'})).status,409);
  await call('/projects',{id:'import-cli',name:'CLI import',storage:'source',import:true,files:[]});
  const {createServer}=await import('node:http');let connections=0;const proxy=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);const response=await fetch(server.url+req.url,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(parts)});res.writeHead(response.status,{'content-type':'application/json'});res.end(Buffer.from(await response.arrayBuffer()));});proxy.on('connection',()=>connections++);await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  try{const options={env:{...process.env,SQUALI_URL:'http://127.0.0.1:'+(proxy.address() as any).port,SQUALI_TOKEN:'local-admin-test-token'},maxBuffer:1024*1024};const args=['scripts/import-source.py','import-cli',repo,'--state',server.dir+'/import-state','--max-objects','100','--max-bytes','1000000'];
  const partial=await exec('python3',[...args,'--max-batches','1'],options).then(r=>({code:0,...r}),e=>e);assert.equal(partial.code,2,partial.stderr);const paused=JSON.parse(partial.stdout);assert.equal(paused.complete,false);assert.equal(paused.objectsProcessed,ids.length);assert.equal(connections,1,"One importer process reuses its HTTP connection across missing and upload");
  const {spawn}=await import('node:child_process');const {once}=await import('node:events');const blocker=spawn('python3',['-c',"import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()",server.dir+'/import-state/import.lock']);await once(blocker.stdout,'data');
  try{const concurrent=await exec('python3',args,options).then(r=>({code:0,...r}),e=>e);assert.equal(concurrent.code,1,'A second process must not share the same durable attempt journal');assert.match(concurrent.stderr,/already running/);}finally{blocker.stdin.end();await once(blocker,'exit');}
  const meter=(await call('/usage')).body.source;const completed=JSON.parse((await exec('python3',args,options)).stdout);assert.equal(completed.complete,true);assert.deepEqual((await call('/usage')).body.source,meter,'Completed object batches are reused on resume');
  const repeated=JSON.parse((await exec('python3',args,options)).stdout);assert.equal(repeated.reused,true);assert.equal(repeated.httpAttempts,completed.httpAttempts);assert.equal(connections,2,'One connection per resumed process and no HTTP on completed replay');}finally{proxy.closeAllConnections();await new Promise<void>(done=>proxy.close(()=>done()));}
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',importedObjects:ids.length,refs:refs.length,sourceCommits:2,binaryExact:true,replayedWrites:0,incompleteRefRejected:true}));
 }finally{await server.close();}
});

test('an ambiguous source upload cannot publish missing content and resumes a late accepted blob without a second put',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile}=await import('node:fs/promises');const {gzipSync}=await import('node:zlib');const exec=promisify(execFile);
 let puts=0,visible=false;let pending:{key:string;bytes:Uint8Array;metadata:Record<string,string>}|undefined;
 const bucket={async put(key:string,bytes:Uint8Array,options:any){puts++;pending={key,bytes,metadata:options.customMetadata};throw Error('Lost upload acknowledgement');},async head(key:string){return visible&&pending?.key===key?{size:pending.bytes.length,customMetadata:pending.metadata}:null;},async get(key:string){return visible&&pending?.key===key?{arrayBuffer:async()=>Uint8Array.from(pending!.bytes).buffer}:null;}};
 const server=await startLocal({port:0,test:true,source:true,sourceBucket:bucket});const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const repo=server.dir+'/late';await exec('git',['init','--initial-branch=main',repo]);await writeFile(repo+'/value.txt','durable after acceptance\n');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture']);
  const ids=(await exec('git',['-C',repo,'rev-list','--objects','--all','--no-object-names'])).stdout.trim().split('\n'),head=(await exec('git',['-C',repo,'rev-parse','HEAD'])).stdout.trim(),objects=[];
  for(const oid of ids){const type=(await exec('git',['-C',repo,'cat-file','-t',oid])).stdout.trim();const raw=(await exec('git',['-C',repo,'cat-file',type,oid],{encoding:'buffer'})).stdout;objects.push({oid,type,encoding:'gzip',body:gzipSync(raw).toString('base64')});}
  await call('/projects',{id:'late-source',name:'Late source',storage:'source',import:true,files:[]});assert.equal((await call('/projects/late-source/source/objects',{objects})).status,503);
  assert.equal((await call('/projects/late-source/source/changesets',{commits:[head]})).status,409,'Missing authoritative data cannot be sealed');
  visible=true;assert.equal((await call('/projects/late-source/source/objects',{objects})).status,200);assert.equal(puts,1,'Resume verifies the accepted key and does not upload it again');
  assert.equal((await call('/projects/late-source/source/changesets',{commits:[head]})).status,200);assert.equal((await call('/projects/late-source/source/finish',{refs:[{name:'refs/heads/main',oid:head}],defaultBranch:'main'})).status,200);assert.equal((await call('/projects/late-source/file?path=value.txt')).body.content,'durable after acceptance\n');
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',ambiguousUpload:true,putAttempts:puts,missingContentNotPublished:true,lateAcceptanceRecovered:true}));
 }finally{await server.close();}
});

test('native source importer transfers an incompressible binary above the JSON batch limit',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile}=await import('node:fs/promises');const {randomBytes}=await import('node:crypto');const exec=promisify(execFile);
 const server=await startLocal({port:0,test:true,source:true});
 try{
  const repo=server.dir+'/binary-source';await exec('git',['init','--initial-branch=main',repo]);const bytes=randomBytes(2*1024*1024);await writeFile(repo+'/binary.dat',bytes);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Binary']);
  const made=await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'binary-source',name:'Binary',storage:'source',import:true,files:[]})});assert.equal(made.status,201);
  const result=await exec('python3',['scripts/import-source.py','binary-source',repo,'--state',server.dir+'/binary-import','--max-objects','100','--max-bytes','10000000'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});assert.equal(JSON.parse(result.stdout).complete,true);
  const response=await fetch(server.url+'/api/projects/binary-source/blob?path=binary.dat',{headers:{authorization:'Bearer local-admin-test-token'}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',binaryBytes:bytes.length,incompressible:true,exactBytes:true}));
 }finally{await server.close();}
});

test('an expired failed source upload can be resumed once without racing an active lease',async()=>{
 const {createHash}=await import('node:crypto');const {gzipSync}=await import('node:zlib');const data=Buffer.from('retry only a confirmed missing immutable blob\n');const oid=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');let puts=0;let stored:Uint8Array|undefined;
 const bucket={async put(_key:string,bytes:Uint8Array){puts++;if(puts===1)throw Error('Connection rejected');stored=bytes;},async head(){return null;},async get(){return stored?{arrayBuffer:async()=>Uint8Array.from(stored!).buffer}:null;}};
 const server=await startLocal({port:0,test:true,source:true,sourceBucket:bucket});const call=async(path:string,value:unknown)=>fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify(value)});
 try{
  await call('/projects',{id:'resume-source',name:'Resume',storage:'source',import:true,files:[]});const batch={objects:[{oid,type:'blob',encoding:'gzip',body:gzipSync(data).toString('base64')}]};
  assert.equal((await call('/projects/resume-source/source/objects',batch)).status,503);assert.equal((await call('/projects/resume-source/source/objects',batch)).status,503);assert.equal(puts,1);
  await server.sql`UPDATE weave_source_blobs SET lease_until=now()-interval '1 second' WHERE state='uploading'`;
  const replies=await Promise.all([call('/projects/resume-source/source/objects',batch),call('/projects/resume-source/source/objects',batch)]);assert.ok(replies.some(r=>r.status===200));assert.equal(puts,2);assert.equal((await call('/projects/resume-source/source/objects',batch)).status,200);assert.equal(puts,2);
  const [usage]=await server.sql`SELECT attempts FROM weave_source_usage WHERE kind='writes'`;assert.equal(Number(usage.attempts),2);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',expiredUploadRecovered:true,putAttempts:puts,concurrentResumeDeduplicated:true}));
 }finally{await server.close();}
});

test('canonical changesets rebuild every Git tree and commit after all compatibility metadata is removed',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {writeFile,mkdir,chmod,symlink,unlink,rm}=await import('node:fs/promises');const exec=promisify(execFile);
 const server=await startLocal({port:0,test:true,source:true});const call=async(path:string,value?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:r.status,body:await r.json() as any};};
 try{
  const repo=server.dir+'/rebuild';await exec('git',['init','--initial-branch=main',repo]);const git=async(...args:string[])=>(await exec('git',['-C',repo,...args])).stdout.trim();await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  await mkdir(repo+'/src');await writeFile(repo+'/src/a.txt','original\n');await writeFile(repo+'/pivot','file before directory\n');await writeFile(repo+'/run.sh','#!/bin/sh\necho hello\n');await chmod(repo+'/run.sh',0o755);await git('add','.');await git('commit','-m','First');const first=await git('rev-parse','HEAD');
  await unlink(repo+'/pivot');await mkdir(repo+'/pivot');await writeFile(repo+'/pivot/inside','nested\n');await git('mv','src/a.txt','src/b.txt');await symlink('src/b.txt',repo+'/link');await git('add','.');await git('commit','-m','Rename and symlink');const second=await git('rev-parse','HEAD');
  await rm(repo+'/pivot',{recursive:true});await writeFile(repo+'/pivot','file after directory\n');await unlink(repo+'/run.sh');await writeFile(repo+'/src/b.txt','changed\n');await git('add','.');await git('commit','-m','Edit and delete');const head=await git('rev-parse','HEAD');
  await call('/projects',{id:'rebuild',name:'Rebuild',storage:'source',import:true,files:[]});await exec('python3',['scripts/import-source.py','rebuild',repo,'--state',server.dir+'/rebuild-import','--max-objects','100','--max-bytes','1000000'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  const writes=(await call('/usage')).body.source.writes;
  await server.sql`DELETE FROM weave_source_objects WHERE project='rebuild' AND kind IN ('tree','commit')`;await server.sql`DELETE FROM weave_derived WHERE project='rebuild'`;await server.sql`DELETE FROM weave_commit_graph WHERE project='rebuild'`;
  const rebuilt=await call('/projects/rebuild/source/derive',{kind:'tree',version:1,changesets:[head]});assert.equal(rebuilt.status,200,JSON.stringify(rebuilt.body));assert.equal(rebuilt.body.results[0].tree,await git('rev-parse','HEAD^{tree}'));
  for(const id of [first,second,head]){const result=await call('/projects/rebuild/commit?ref='+id);assert.equal(result.status,200);assert.equal(result.body.tree,await git('rev-parse',id+'^{tree}'));const [stored]=await server.sql`SELECT raw FROM weave_source_objects WHERE project='rebuild' AND oid=${id}`;const native=(await exec('git',['-C',repo,'cat-file','commit',id],{encoding:'buffer'})).stdout;assert.deepEqual(stored.raw,native);}
  assert.equal((await call('/projects/rebuild/file?path=src/b.txt')).body.content,'changed\n');assert.equal((await call('/projects/rebuild/file?path=run.sh')).status,404);assert.equal((await call('/usage')).body.source.writes,writes);
  const indexes=await call('/projects/rebuild/source/derive',{kind:'indexes',version:1,changesets:[first,second,head]});assert.equal(indexes.status,200,JSON.stringify(indexes.body));assert.equal((await call('/projects/rebuild/index?ref='+head)).body.complete,true);
  const generation=await call('/projects/rebuild/source/derive',{kind:'generation',version:1,changesets:[head]});assert.equal(generation.status,200);assert.equal(generation.body.results[0].generation,3);
  const version=await call('/projects/rebuild/source/derive',{kind:'tree',version:99,changesets:[head]});assert.equal(version.status,400);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',canonicalRebuild:true,removedAllGitMetadata:true,nativeCommitsExact:3,versionedRecursiveDerivation:true,extraBlobWrites:0}));
 }finally{await server.close();}
});

test('source RPC serves verified raw objects and file sizes without fetching file content during directory inspection',async()=>{
 const {createHash}=await import('node:crypto');const server=await startLocal({port:0,test:true,source:true});
 const call=(path:string,body:unknown,token='local-admin-test-token')=>fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  const p=await (await call('/projects',{id:'rpc-source',name:'RPC',storage:'source',files:[{path:'src/a.txt',content:'hello\n'},{path:'large.dat',content:'z'.repeat(128000)}]})).json() as any;
  const before=await server.sql`SELECT attempts FROM weave_source_usage WHERE kind='reads'`;
  const rpc=(body:unknown)=>call('/projects/rpc-source/rpc',body);
  const commit=await rpc({op:'object',oid:p.head});assert.equal(commit.status,200);assert.equal(commit.headers.get('x-squali-type'),'commit');const raw=Buffer.from(await commit.arrayBuffer());assert.equal(createHash('sha1').update(`commit ${raw.length}\0`).update(raw).digest('hex'),p.head);
  const tree=raw.toString().match(/^tree (\w+)/)![1];const treeResponse=await rpc({op:'object',oid:tree});assert.equal(treeResponse.headers.get('x-squali-type'),'tree');const entries=await server.sql`SELECT oid,size FROM weave_source_objects WHERE project='rpc-source' AND kind='blob'`;
  const sizes=await (await rpc({op:'stat',oids:entries.map(r=>r.oid)})).json() as any;assert.deepEqual(sizes.objects.map((r:any)=>r.size).sort((a:number,b:number)=>a-b),[6,128000]);assert.deepEqual(await server.sql`SELECT attempts FROM weave_source_usage WHERE kind='reads'`,before);
  const blob=await rpc({op:'object',oid:entries[0].oid});assert.equal(blob.status,200);const bytes=Buffer.from(await blob.arrayBuffer());assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),entries[0].oid);
  assert.equal((await call('/projects/rpc-source/rpc',{op:'head'},'invalid')).status,401);assert.equal((await rpc({op:'object',oid:'main'})).status,400);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',rawObjectRpc:true,metadataOnlyInspection:true,hashVerified:true}));
 }finally{await server.close();}
});

test('regional source object cache serves immutable hits and fails closed when its cache layer fails',async()=>{
 const {memoryCache}=await import('../src/cache.ts');const cache=memoryCache();let failed=false;const boundary={async get(key:string){if(failed)throw Error('Cache unavailable');return cache.get(key);},set:cache.set};
 const server=await startLocal({port:0,test:true,source:true,sourceCache:boundary});
 const call=async(path:string,value?:unknown)=>fetch(server.url+'/api'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
 try{
  await call('/projects',{id:'regional-source',name:'Regional',storage:'source',files:[{path:'file.txt',content:'immutable regional data\n'}]});
  const read=()=>call('/projects/regional-source/blob?path=file.txt');assert.equal((await read()).status,200);assert.equal((await read()).status,200);
  const before=await (await call('/usage')).json() as any;assert.equal(before.source.reads,1);
  failed=true;assert.equal((await read()).status,503);const after=await (await call('/usage')).json() as any;assert.equal(after.source.reads,1,'Cache failure must not bypass the layer and fan out to R2');
 }finally{await server.close();}
});

test('imported deep history has eager graph jumps and indexed path history and blame despite unrelated file churn',async()=>{
 const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const server=await startLocal({port:0,test:true,source:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
 try{
  const native=server.dir+'/source-deep.git';await exec('git',['init','--bare','--initial-branch=main',native]);let input='blob\nmark :10000\ndata 7\nstable\n\n';
  for(let i=1;i<=512;i++){const message='commit '+i,body='counter '+i+'\n';input+=`blob\nmark :${20000+i}\ndata ${Buffer.byteLength(body)}\n${body}\ncommit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1700000000+i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${i>1?'from :'+(i-1)+'\n':''}M 100644 :10000 stable.txt\nM 100644 :${20000+i} counter.txt\n\n`;}
  const proc=spawn('git',['--git-dir',native,'fast-import','--quiet']);proc.stdin.end(input);let errors='';proc.stderr.on('data',b=>errors+=b);await new Promise<void>((done,fail)=>proc.on('close',code=>code===0?done():fail(Error(errors))));const git=async(...args:string[])=>(await exec('git',['--git-dir',native,...args])).stdout.trim();const head=await git('rev-parse','main'),first=await git('rev-list','--max-parents=0','main');
  await call('/projects',{id:'source-deep',name:'Source deep history',storage:'source',import:true,files:[]});await exec('python3',['scripts/import-source.py','source-deep',native,'--state',server.dir+'/deep-import','--max-objects','5000','--max-bytes','10000000'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'},timeout:60000});
  assert.equal((await call('/projects/source-deep/index?ref='+head)).complete,true);const bisect=await call('/projects/source-deep/bisect',{good:first,bad:head});assert.equal(bisect.candidate,await git('rev-parse','main~255'));
  const before=(await call('/usage')).source;const history=await call('/projects/source-deep/path-history?ref='+head+'&path=stable.txt');assert.deepEqual(history.commits.map((c:any)=>c.oid),[first]);assert.equal(history.next,null);assert.ok(history.scanned<=2,'Path index skips unrelated file churn');
  const blame=await call('/projects/source-deep/blame?ref='+head+'&path=stable.txt');assert.deepEqual(blame.lines.map((l:any)=>l.commit),[first]);const after=(await call('/usage')).source;assert.equal(after.writes,before.writes);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',nativeCommits:512,eagerGraph:true,pathCandidates:history.scanned,unrelatedChurnSkipped:511,blameMatchesNative:true}));
 }finally{await server.close();}
});

test('source reconstruction preserves legacy non-UTF-8 commit metadata byte for byte',async()=>{
 const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const server=await startLocal({port:0,test:true,source:true});const auth={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 try{
  const repo=server.dir+'/legacy.git';await exec('git',['init','--bare','--initial-branch=main',repo]);const write=async(type:string,data:Buffer)=>{const p=spawn('git',['--git-dir',repo,'hash-object','-t',type,'-w','--stdin']);let out='';p.stdout.on('data',b=>out+=b);p.stdin.end(data);await new Promise<void>((done,fail)=>p.on('close',code=>code===0?done():fail(Error('Git object rejected'))));return out.trim();};
  const tree=await write('tree',Buffer.alloc(0));const raw=Buffer.from(`tree ${tree}\nauthor Jos\xe9 <fixture@example.invalid> 1700000000 +0000\ncommitter Jos\xe9 <fixture@example.invalid> 1700000000 +0000\nencoding ISO-8859-1\n\ncaf\xe9\n`,'latin1');const head=await write('commit',raw);await exec('git',['--git-dir',repo,'update-ref','refs/heads/main',head]);
  await fetch(server.url+'/api/projects',{method:'POST',headers:auth,body:JSON.stringify({id:'legacy-source',name:'Legacy encoding',storage:'source',import:true,files:[]})});await exec('python3',['scripts/import-source.py','legacy-source',repo,'--state',server.dir+'/legacy-import','--max-objects','10','--max-bytes','10000'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  await server.sql`DELETE FROM weave_source_objects WHERE project='legacy-source'`;await server.sql`DELETE FROM weave_derived WHERE project='legacy-source'`;
  const rebuilt=await fetch(server.url+'/api/projects/legacy-source/source/derive',{method:'POST',headers:auth,body:JSON.stringify({kind:'tree',version:1,changesets:[head]})});assert.equal(rebuilt.status,200,await rebuilt.text());const [record]=await server.sql`SELECT raw FROM weave_source_objects WHERE project='legacy-source' AND oid=${head}`;assert.deepEqual(record.raw,raw);
 }finally{await server.close();}
});

test('historic Git permission modes import without changing immutable tree identity',async()=>{
 const {readFile}=await import('node:fs/promises');const {gzipSync}=await import('node:zlib');const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const server=await startLocal({port:0,test:true,source:true});const auth={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const call=async(path:string,body:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:'POST',headers:auth,body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const original=JSON.parse(await readFile('tests/fixtures/legacy-git-tree.json','utf8'));await call('/projects',{id:'historic-tree',name:'Historic tree',storage:'source',import:true,files:[]});const imported=await call('/projects/historic-tree/source/objects',{objects:[{oid:original.oid,type:'tree',encoding:'gzip',body:gzipSync(Buffer.from(original.body,'base64')).toString('base64')}]});assert.equal(imported.status,200,JSON.stringify(imported.body));
  const repo=server.dir+'/modes.git';await exec('git',['init','--bare','--initial-branch=main',repo]);const write=async(type:string,data:Buffer)=>{const p=spawn('git',['--git-dir',repo,'hash-object','--literally','-t',type,'-w','--stdin']);let out='';p.stdout.on('data',b=>out+=b);p.stdin.end(data);await new Promise<void>((done,fail)=>p.on('close',code=>code===0?done():fail(Error('Git rejected fixture'))));return out.trim();};
  const blob=await write('blob',Buffer.from('historic file\n'));const rawTree=Buffer.concat([Buffer.from('100664 file.txt\0'),Buffer.from(blob,'hex')]);const tree=await write('tree',rawTree);const raw=Buffer.from(`tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nHistoric mode\n`),head=await write('commit',raw);await exec('git',['--git-dir',repo,'update-ref','refs/heads/main',head]);
  await call('/projects',{id:'historic-source',name:'Historic source',storage:'source',import:true,files:[]});await exec('python3',['scripts/import-source.py','historic-source',repo,'--state',server.dir+'/historic-import','--max-objects','10','--max-bytes','10000'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  const file=await fetch(server.url+'/api/projects/historic-source/file?path=file.txt',{headers:auth}).then(r=>r.json()) as any;assert.equal(file.content,'historic file\n');assert.equal(file.mode,'100644');
  await server.sql`DELETE FROM weave_source_objects WHERE project='historic-source' AND kind IN ('tree','commit')`;await server.sql`DELETE FROM weave_derived WHERE project='historic-source'`;
  const rebuilt=await call('/projects/historic-source/source/derive',{kind:'tree',version:1,changesets:[head]});assert.equal(rebuilt.status,200,JSON.stringify(rebuilt.body));assert.equal(rebuilt.body.results[0].tree,tree);const [stored]=await server.sql`SELECT raw FROM weave_source_objects WHERE project='historic-source' AND oid=${tree}`;assert.deepEqual(stored.raw,rawTree);
  console.log(JSON.stringify({command:'node --import tsx --test tests/source.test.ts',originalFailingTree:original.oid,historicMode:'100664',displayMode:'100644',reconstructedBytesExact:true}));
 }finally{await server.close();}
});

test('a lost retry acknowledgement recovers when the gzip representation differs from the original claim',async()=>{
 const {gzipSync}=await import('node:zlib'),{createHash}=await import('node:crypto');let puts=0;const stored=new Map<string,{data:Uint8Array;metadata:Record<string,string>}>();
 const bucket={async put(key:string,data:Uint8Array,options:any){puts++;if(puts===1)throw Error('No upload accepted');stored.set(key,{data,metadata:options.customMetadata});if(puts===2)throw Error('Retry accepted but acknowledgement lost');},async head(key:string){const o=stored.get(key);return o?{size:o.data.length,customMetadata:o.metadata}:null;},async get(key:string){const o=stored.get(key);return o?{arrayBuffer:async()=>Uint8Array.from(o.data).buffer}:null;}};
 const server=await startLocal({port:0,test:true,source:true,sourceBucket:bucket});const call=async(path:string,body:unknown)=>fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify(body)});
 try{await call('/projects',{id:'gzip-retry',name:'Gzip recovery',storage:'source',import:true,files:[]});const data=Buffer.from('independent immutable source\n'.repeat(1000)),oid=createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');const request=(level:1|9)=>({objects:[{oid,type:'blob',encoding:'gzip',body:gzipSync(data,{level}).toString('base64')}]});assert.notEqual(request(1).objects[0].body.length,request(9).objects[0].body.length);
  assert.equal((await call('/projects/gzip-retry/source/objects',request(1))).status,503);await server.sql`UPDATE weave_source_blobs SET lease_until=now()-interval '1 second' WHERE state='uploading'`;assert.equal((await call('/projects/gzip-retry/source/objects',request(9))).status,503);const recovered=await call('/projects/gzip-retry/source/objects',request(1));assert.equal(recovered.status,200,await recovered.text());assert.equal(puts,2);await call('/projects/gzip-retry/source/finish',{refs:[],defaultBranch:'main'});const read=await call('/projects/gzip-retry/rpc',{op:'object',oid});assert.deepEqual(Buffer.from(await read.arrayBuffer()),data);
 }finally{await server.close();}
});


test('a parent-ordered import seals 128 changesets in bounded database batches',async()=>{
 const {spawn,execFile}=await import('node:child_process'),{promisify}=await import('node:util');const exec=promisify(execFile);let queries=0;
 const server=await startLocal({port:0,test:true,source:true,onQuery:()=>queries++});const auth={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const call=(path:string,body:unknown)=>fetch(server.url+'/api'+path,{method:'POST',headers:auth,body:JSON.stringify(body)});
 try{
  const repo=server.dir+'/batch.git';await exec('git',['init','--bare',repo]);let input='';
  for(let i=0;i<128;i++){const content='value '+i+'\n';input+=`commit refs/heads/main\nmark :${i+1}\ncommitter Fixture <fixture@example.invalid> ${1700000000+i} +0000\ndata 6\nStep ${i%10}\n${i?'from :'+i+'\n':''}M 100644 inline src/value.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;}
  const writer=spawn('git',['--git-dir',repo,'fast-import','--quiet']);writer.stdin.end(input);await new Promise<void>((done,fail)=>writer.on('close',code=>code===0?done():fail(Error('Fixture import failed'))));await exec('git',['--git-dir',repo,'symbolic-ref','HEAD','refs/heads/main']);
  await call('/projects',{id:'batch',name:'Batched history',storage:'source',import:true,files:[]});
  const partial=await exec('python3',['scripts/import-source.py','batch',repo,'--state',server.dir+'/batch-import','--max-batches','4'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}}).then(r=>({code:0,...r}),e=>e);assert.equal(partial.code,2,partial.stderr);assert.equal(JSON.parse(partial.stdout).objectsProcessed,512);
  const commits=(await exec('git',['--git-dir',repo,'rev-list','--reverse','--topo-order','--all'])).stdout.trim().split('\n');queries=0;const started=performance.now();const result=await call('/projects/batch/source/changesets',{commits});assert.equal(result.status,200,await result.text());const count=queries;
  assert.ok(count<=64,`128 changesets used ${count} SQL round trips; budget is 64`);
  const head=commits.at(-1)!;assert.equal((await call('/projects/batch/source/finish',{refs:[{name:'refs/heads/main',oid:head}],defaultBranch:'main'})).status,200);
  const graph=await fetch(server.url+'/api/projects/batch/index?ref='+head,{headers:auth}).then(r=>r.json()) as any;assert.equal(graph.complete,true);assert.equal(graph.generation,128);
  const file=await fetch(server.url+'/api/projects/batch/file?path=src/value.txt',{headers:auth}).then(r=>r.json()) as any;assert.equal(file.content,'value 127\n');
  await call('/projects',{id:'adaptive',name:'Adaptive metadata batches',storage:'source',import:true,files:[]});
  const {createServer}=await import('node:http');const sealedSizes:number[]=[];const proxy=createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);const raw=Buffer.concat(parts);if(req.url?.endsWith('/changesets')){const batch=JSON.parse(raw.toString()).commits;sealedSizes.push(batch.length);if(batch.length>64){res.writeHead(413,{'content-type':'application/json'}).end(JSON.stringify({error:'source_seal_budget',message:'Metadata batch is too large'}));return;}}const result=await fetch(server.url+req.url,{method:req.method,headers:req.headers as Record<string,string>,body:raw});res.writeHead(result.status,{'content-type':'application/json'});res.end(Buffer.from(await result.arrayBuffer()));});await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  try{const completed=await exec('python3',['scripts/import-source.py','adaptive',repo,'--state',server.dir+'/adaptive'],{env:{...process.env,SQUALI_URL:'http://127.0.0.1:'+(proxy.address() as any).port,SQUALI_TOKEN:'local-admin-test-token'}});assert.equal(JSON.parse(completed.stdout).complete,true);assert.deepEqual(sealedSizes,[128,64,64],'Only rejected metadata batches are split; accepted parent batches are reused');}finally{proxy.closeAllConnections();await new Promise<void>(done=>proxy.close(()=>done()));}
  console.log(JSON.stringify({command:'node --import tsx --test --test-name-pattern="parent-ordered" tests/source.test.ts',commits:128,queries:count,ms:Math.round(performance.now()-started)}));
 }finally{await server.close();}
});

test('source import completes when its Git compatibility copy exceeds the provider budget',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{writeFile}=await import('node:fs/promises');const exec=promisify(execFile);const server=await startLocal({port:0,test:true,source:true}),headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 try{
  const repo=server.dir+'/source-limit';await exec('git',['init','--initial-branch=main',repo]);await writeFile(repo+'/README.md','Source remains usable beyond a Git provider limit.\n');await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','Source authority']);
  await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'source-limit',name:'Independent source',storage:'source',import:true,files:[]})});
  const imported=await exec('python3',['scripts/import-source.py','source-limit',repo,'--state',server.dir+'/source-limit-state','--git-export-max-bytes','1'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_JOB_LEASE:'budget-fixture'}});assert.equal(JSON.parse(imported.stdout).complete,true);
  const status=await fetch(server.url+'/api/projects/source-limit/source',{headers}).then(r=>r.json()) as any;assert.equal(status.gitCompatibility.state,'provider_limit');assert.equal(status.changesets,1);
  const read=await fetch(server.url+'/api/projects/source-limit/file?path=README.md',{headers}).then(r=>r.json()) as any;assert.equal(read.content,'Source remains usable beyond a Git provider limit.\n');
  const git=await fetch(server.url+'/api/projects/source-limit/git/info/refs?service=git-upload-pack',{headers});assert.equal(git.status,413);assert.equal((await git.json() as any).error,'git_compatibility_limit');
  const usage=await fetch(server.url+'/api/usage',{headers}).then(r=>r.json()) as any;assert.equal(usage.attempts,0,'Oversized compatibility export makes no Artifacts call');
  console.log(JSON.stringify({command:'node --import tsx --test --test-name-pattern="provider budget" tests/source.test.ts',sourceComplete:true,compatibilityLimitExplicit:true,artifactsCalls:0}));
 }finally{await server.close();}
});

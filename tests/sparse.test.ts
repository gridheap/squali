import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,stat,mkdir,symlink,chmod,unlink} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);

test('sparse CLI checks out only requested paths, reuses immutable objects, hydrates and proposes without Git clone',async()=>{
 const server=await startLocal({port:0,test:true});const root=await mkdtemp('work/sparse-');
 const api=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 const cli=async(args:string[],token='local-admin-test-token')=>JSON.parse((await exec('node',['scripts/working-copy.mjs',...args],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:token,SQUALI_CACHE_DIR:root+'/cache'}})).stdout);
 try{
  const created=await api('/projects',{id:'sparse',name:'Sparse',files:[{path:'src/one.ts',content:'export const one = 1;\n'},{path:'src/two.ts',content:'export const two = 2;\n'},{path:'docs/guide.md',content:'Read on demand\n'},{path:'tools/check.sh',content:'#!/bin/sh\nexit 0\n',mode:'100755'}]});assert.equal(created.status,201);
  const batch=await api('/projects/sparse/objects',{objects:[{type:'commit',oid:created.body.head}]});assert.equal(batch.status,200);assert.equal(batch.body.objects[0].value.oid,created.body.head);
  assert.equal((await api('/projects/sparse/objects',{objects:[{type:'blob',oid:'../../bad'}]})).status,400);
  assert.equal((await api('/projects/sparse/objects',{objects:Array(33).fill({type:'commit',oid:created.body.head})})).status,400);
  const one=await cli(['checkout','sparse',root+'/one','src']);assert.equal(one.files,2);assert.equal(await readFile(root+'/one/src/one.ts','utf8'),'export const one = 1;\n');await assert.rejects(stat(root+'/one/docs'));await assert.rejects(stat(root+'/one/.git'));
  const two=await cli(['checkout','sparse',root+'/two','src']);assert.equal(two.networkObjects,0,'Second client uses the shared node cache after authorization');assert.ok(two.cacheHits>=4);
  await assert.rejects(cli(['checkout','sparse',root+'/unauthorized','src'],'invalid'));
  const hydrated=await cli(['hydrate',root+'/one','tools/check.sh']);assert.equal(hydrated.files,1);assert.equal((await stat(root+'/one/tools/check.sh')).mode&0o777,0o755);
  await writeFile(root+'/one/src/one.ts','export const one = 3;\n');const status=await cli(['status',root+'/one']);assert.deepEqual(status.changes.map((v:any)=>v.path),['src/one.ts']);
  await assert.rejects(cli(['hydrate',root+'/one','src/one.ts']),'Never overwrite locally changed files');
  const proposal=await cli(['propose',root+'/one','sparse-change','Update one']);assert.equal(proposal.base,created.body.head);const details=await api('/projects/sparse/changes/sparse-change');assert.equal(details.body.files.length,1);
  const clean=await cli(['status',root+'/two']);assert.deepEqual(clean.changes,[]);
  console.log(JSON.stringify({command:'pnpm test:sparse',sourceFiles:4,sparseFiles:one.files,firstNetworkObjects:one.networkObjects,secondNetworkObjects:two.networkObjects,sharedCacheHits:two.cacheHits,hydratedFiles:hydrated.files,gitClone:false,proposal:proposal.id}));
 }finally{await server.close();}
});

test('working-copy update survives process death and preserves edits, hydrated paths and file modes',async()=>{
 const server=await startLocal({port:0,test:true});const root=await mkdtemp('work/sparse-update-'),copy=root+'/copy';
 const api=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_CACHE_DIR:root+'/cache'};
 const cli=async(...args:string[])=>JSON.parse((await exec('node',['scripts/working-copy.mjs',...args],{env})).stdout);
 try{
  await api('/projects',{id:'update',name:'Update',files:[{path:'src/base.txt',content:'old\n'},{path:'src/delete.txt',content:'remove\n'},{path:'tools/run.sh',content:'echo ok\n'},{path:'docs/guide.md',content:'old guide\n'}]});
  await cli('checkout','update',copy,'src','tools');await cli('hydrate',copy,'docs/guide.md');await writeFile(copy+'/src/notes.local','keep local\n');
  await api('/projects/update/changes',{id:'remote',title:'Remote update',intent:'Update the sparse working tree',files:[{path:'src/base.txt',content:'new\n'},{path:'src/delete.txt',content:null},{path:'src/new.txt',content:'remote new\n'},{path:'tools/run.sh',content:'echo ok\n',mode:'100755'},{path:'docs/guide.md',content:'new guide\n'}]});
  await api('/projects/update/changes/remote/review',{decision:'approved'});const published=await api('/projects/update/publish',{id:'remote-batch',changes:['remote']});assert.equal(published.status,201);
  await writeFile(copy+'/src/base.txt','local edit\n');await assert.rejects(cli('update',copy));assert.equal(await readFile(copy+'/src/base.txt','utf8'),'local edit\n');assert.equal(await readFile(copy+'/docs/guide.md','utf8'),'old guide\n');
  await writeFile(copy+'/src/base.txt','old\n');await writeFile(copy+'/src/new.txt','untracked collision\n');await assert.rejects(cli('update',copy));assert.equal(await readFile(copy+'/src/new.txt','utf8'),'untracked collision\n');await unlink(copy+'/src/new.txt');
  // Fault injection is at the operating-system boundary, outside product code.
  // Kill only after one real file replacement and before its await resumes.
  const preload=resolve(root,'pause-after-write.mjs');await writeFile(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.promises.rename;fs.promises.rename=async(a,b)=>{await rename(a,b);if(String(b).endsWith('/src/base.txt')){process.send?.({replaced:true});await new Promise(()=>{});}};syncBuiltinESMExports();`);
  const child=spawn('node',['--import',preload,'scripts/working-copy.mjs','update',copy],{env,stdio:['ignore','pipe','pipe','ipc']});let errors='';child.stderr!.on('data',c=>errors+=c);child.stdout!.resume();
  await new Promise<void>((done,fail)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error('Update did not reach replacement: '+errors));},10000);child.once('message',()=>{clearTimeout(timer);done();});child.once('exit',()=>{clearTimeout(timer);fail(Error('Update exited before replacement: '+errors));});});
  const killed=new Promise<void>(done=>child.once('exit',()=>done()));child.kill('SIGKILL');await killed;
  await writeFile(copy+'/src/base.txt','edit after interruption\n');await assert.rejects(cli('update',copy));assert.equal(await readFile(copy+'/src/base.txt','utf8'),'edit after interruption\n');
  await writeFile(copy+'/src/base.txt','new\n');const updated=await cli('update',copy);assert.equal(updated.ref,published.body.oid);
  assert.equal(await readFile(copy+'/docs/guide.md','utf8'),'new guide\n');assert.equal(await readFile(copy+'/src/new.txt','utf8'),'remote new\n');assert.equal(await readFile(copy+'/src/notes.local','utf8'),'keep local\n');await assert.rejects(stat(copy+'/src/delete.txt'));assert.equal((await stat(copy+'/tools/run.sh')).mode&0o777,0o755);
  assert.deepEqual((await cli('status',copy)).changes,[]);await assert.rejects(stat(copy+'/.squali/update.json'));
  console.log(JSON.stringify({command:'pnpm test:sparse',update:true,realProcessDeath:true,editedAfterCrashProtected:true,hydratedPathRetained:true,executableMode:true,untrackedPreserved:true}));
 }finally{await server.close();}
});

test('sparse clients explicitly add new files and preserve unseen remote content',async()=>{
 const server=await startLocal({port:0,test:true});const root=await mkdtemp('work/sparse-add-');
 const api=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 const cli=async(...args:string[])=>JSON.parse((await exec('node',['scripts/working-copy.mjs',...args],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_CACHE_DIR:root+'/cache'}})).stdout);
 try{
  await api('/projects',{id:'sparse-add',name:'Add',files:[{path:'src/existing.txt',content:'existing\n'},{path:'docs/unseen.txt',content:'do not replace\n'}]});
  await cli('checkout','sparse-add',root+'/copy','src');
  await writeFile(root+'/copy/src/new.txt','new file\n');
  const added=await cli('add',root+'/copy','src/new.txt');assert.deepEqual(added.added,['src/new.txt']);
  await mkdir(root+'/copy/docs');await writeFile(root+'/copy/docs/unseen.txt','unsafe replacement\n');await assert.rejects(cli('add',root+'/copy','docs/unseen.txt'));
  await symlink('existing.txt',root+'/copy/src/link.txt');await assert.rejects(cli('add',root+'/copy','src/link.txt'));
  const status=await cli('status',root+'/copy');assert.deepEqual(status.changes.map((c:any)=>c.path),['src/new.txt']);
  await assert.rejects(cli('add',root+'/copy','../outside'));
  const proposal=await cli('propose',root+'/copy','add-file','Add new file');assert.equal(proposal.status,'proposed');
  const committed=await cli('status',root+'/copy');assert.equal(committed.base,proposal.oid);assert.deepEqual(committed.changes,[],'Accepted server changes become the working-copy base');
  await api('/projects/sparse-add/changes/add-file/review',{decision:'approved'});const publication=await api('/projects/sparse-add/publish',{id:'publish-added',changes:['add-file']});assert.equal(publication.status,201);
  assert.equal((await api('/projects/sparse-add/file?path=src/new.txt')).body.content,'new file\n');
  assert.equal((await api('/projects/sparse-add/file?path=docs/unseen.txt')).body.content,'do not replace\n');
  console.log(JSON.stringify({command:'pnpm test:sparse',explicitAdd:true,published:true,unseenContentPreserved:true}));
 }finally{await server.close();}
});

test('sparse checkout reads a large imported binary through an authorized bounded raw endpoint',async()=>{
 const server=await startLocal({port:0,test:true});const root=await mkdtemp('work/large-blob-');
 const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 try{
  const p=await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'binary',name:'Binary source',files:[{path:'small.txt',content:'small'}]})}).then(r=>r.json()) as any;
  await exec('git',['clone',p.remote,root+'/source']);const bytes=Buffer.alloc(2*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;await writeFile(root+'/source/asset.bin',bytes);
  await exec('git',['-C',root+'/source','add','asset.bin']);await exec('git',['-C',root+'/source','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Large binary']);await exec('git',['-C',root+'/source','push','origin','main']);
  const raw=await fetch(server.url+'/api/projects/binary/blob?path=asset.bin',{headers});assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes);
  assert.equal((await fetch(server.url+'/api/projects/binary/blob?path=asset.bin')).status,401);
  const run=async(name:string)=>JSON.parse((await exec('node',['scripts/working-copy.mjs','checkout','binary',root+'/'+name,'asset.bin'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_CACHE_DIR:root+'/cache'}})).stdout);
  const first=await run('one'),second=await run('two');assert.deepEqual(await readFile(root+'/one/asset.bin'),bytes);assert.deepEqual(await readFile(root+'/two/asset.bin'),bytes);assert.equal(second.networkObjects,0);
  console.log(JSON.stringify({command:'pnpm test:sparse',binaryBytes:bytes.length,firstNetworkObjects:first.networkObjects,repeatedNetworkObjects:second.networkObjects,exactBytes:true}));
 }finally{await server.close();}
});

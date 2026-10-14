import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
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

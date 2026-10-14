import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';
import {createHash} from 'node:crypto';

// Failure specification: online proposals re-read admitted trees to rediscover
// their known delta; direct changesets diverge from imported canonical identity;
// deletion/mode-only changes disappear; replay writes duplicate source blobs;
// eager graph/path derivation reloads its already validated canonical input.
test('online proposal persists its known delta with bounded SQL and exact import identity',async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,source:true,poolSize:1,onQuery:()=>queries++});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};
 try{
  const project=await call('/projects',{id:'direct',name:'Direct source delta',files:[{path:'src/update.txt',content:'before\n'},{path:'delete.txt',content:'remove\n'},{path:'run.sh',content:'echo ok\n'},{path:'keep.txt',content:'preserve\n'}]});
  const input={id:'direct',title:'Known delta',intent:'Write only the reviewed changes',base:project.head,files:[{path:'src/update.txt',content:'after\n'},{path:'delete.txt',content:null},{path:'run.sh',content:'echo ok\n',mode:'100755'},{path:'nested/new.txt',content:'new\n'}]};
  queries=0;const proposed=await call('/projects/direct/changes',input),count=queries;
  const original=await call('/projects/direct/changesets/'+proposed.oid),usage=(await call('/usage')).source;
  assert.equal(original.files.length,4);assert.equal(original.files.find((f:any)=>f.path==='delete.txt').mode,null);assert.equal(original.files.find((f:any)=>f.path==='run.sh').mode,'100755');
  await server.sql`DELETE FROM weave_changesets WHERE project='direct' AND git_oid=${proposed.oid}`;
  await call('/projects/direct/source/changesets',{commits:[proposed.oid]});
  const reconstructed=await call('/projects/direct/changesets/'+proposed.oid);assert.equal(reconstructed.id,original.id);assert.deepEqual(reconstructed.files,original.files);assert.deepEqual(reconstructed.metadata,original.metadata);
  assert.equal((await call('/projects/direct/file?ref='+proposed.oid+'&path=keep.txt')).content,'preserve\n');
  await call('/projects/direct/changes',input);assert.equal((await call('/usage')).source.writes,usage.writes);
  console.log(JSON.stringify({command:'node --import tsx --test tests/proposal-cost.test.ts',queries:count,canonicalIdentityMatchesImport:true,changes:4,replayExtraBlobWrites:0}));
  assert.ok(count<=33,'Online proposal used '+count+' SQL queries; reuse its known file delta');
 }finally{await server.close();}
});

// Admission must preserve one durable identity when an upload is in flight;
// changed input cannot reuse it, missing dependencies must leave no proposal,
// and recovering the same request must not write its source blob a second time.
test('proposal admission retains one identity across an in-flight duplicate and invalid dependencies',async()=>{
 const bodies=new Map<string,{bytes:Buffer;metadata:Record<string,string>}>();let release!:()=>void,entered!:()=>void,blocked=false;
 const wait=new Promise<void>(done=>release=done),started=new Promise<void>(done=>entered=done),target='blobs/v1/'+createHash('sha256').update('new\n').digest('hex');let targetPuts=0;
 const bucket={async put(key:string,bytes:Uint8Array,options:any){if(key===target){targetPuts++;if(!blocked){blocked=true;entered();await wait;}}bodies.set(key,{bytes:Buffer.from(bytes),metadata:options.customMetadata});},async head(key:string){const value=bodies.get(key);return value?{size:value.bytes.length,customMetadata:value.metadata}:null;},async get(key:string){const value=bodies.get(key);return value?{arrayBuffer:async()=>Uint8Array.from(value.bytes).buffer}:null;}};
 const server=await startLocal({port:0,test:true,source:true,sourceBucket:bucket});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  assert.equal((await call('/projects',{id:'admit',name:'Admission',files:[{path:'base.txt',content:'base\n'}]})).status,201);
  const input={id:'same',title:'One immutable change',intent:'Retain the write journal',files:[{path:'new.txt',content:'new\n'}]};
  const original=call('/projects/admit/changes',input);await started;
  assert.equal((await call('/projects/admit/changes',{...input,title:'Different input'})).status,409);
  assert.equal((await call('/projects/admit/changes',input)).status,503,'A duplicate waits for the retained upload lease');
  release();const accepted=await original;assert.equal(accepted.status,201,JSON.stringify(accepted.body));
  assert.equal((await call('/projects/admit/changes',input)).body.oid,accepted.body.oid);assert.equal(targetPuts,1);
  const invalid=await call('/projects/admit/changes',{...input,id:'missing',dependencies:['same','absent']});assert.equal(invalid.status,409);assert.equal(invalid.body.error,'dependency_missing');
  assert.equal((await call('/projects/admit/changes/missing')).status,404);
  const valid=await call('/projects/admit/changes',{...input,id:'dependent',dependencies:['same']});assert.equal(valid.status,201,JSON.stringify(valid.body));assert.deepEqual(valid.body.dependencies,['same']);assert.equal(targetPuts,1);
  const events=(await call('/projects/admit/events')).body.events.filter((e:any)=>e.kind==='change.proposed'&&e.data.id==='same');assert.equal(events.length,1);
  console.log(JSON.stringify({command:'node --import tsx --test tests/proposal-cost.test.ts',duplicatePending:true,changedInputRejected:true,missingDependencyNotAdmitted:true,blobPuts:targetPuts,proposalEvents:events.length}));
 }finally{release();await server.close();}
});

test('one 64-file proposal stores its path index in one bounded SQL batch',async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,source:true,poolSize:1,onQuery:()=>queries++});
 const call=async(path:string,body:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};
 try{
  await call('/projects',{id:'many',name:'Batch paths',files:[{path:'README.md',content:'baseline\n'}]});
  queries=0;const change=await call('/projects/many/changes',{id:'files',title:'Many files',intent:'Bound metadata round trips',files:Array.from({length:64},(_,i)=>({path:'src/'+i+'.txt',content:'line '+i+'\n'}))}),count=queries;
  assert.equal(change.files.length,64);assert.equal(Number((await server.sql`SELECT count(*) FROM weave_paths WHERE project='many' AND change_id='files'`)[0].count),64);
  console.log(JSON.stringify({command:'node --import tsx --test tests/proposal-cost.test.ts',files:64,queries:count}));
  assert.ok(count<=32,'The 64-file proposal used '+count+' SQL queries');
 }finally{await server.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

// Failure specification: online proposals re-read admitted trees to rediscover
// their known delta; direct changesets diverge from imported canonical identity;
// deletion/mode-only changes disappear; replay writes duplicate source blobs.
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
  assert.ok(count<=45,'Online proposal used '+count+' SQL queries; reuse its known file delta');
 }finally{await server.close();}
});

test('one 64-file proposal stores its path index in one bounded SQL batch',async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,source:true,poolSize:1,onQuery:()=>queries++});
 const call=async(path:string,body:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify(body)});const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};
 try{
  await call('/projects',{id:'many',name:'Batch paths',files:[{path:'README.md',content:'baseline\n'}]});
  queries=0;const change=await call('/projects/many/changes',{id:'files',title:'Many files',intent:'Bound metadata round trips',files:Array.from({length:64},(_,i)=>({path:'src/'+i+'.txt',content:'line '+i+'\n'}))}),count=queries;
  assert.equal(change.files.length,64);assert.equal(Number((await server.sql`SELECT count(*) FROM weave_paths WHERE project='many' AND change_id='files'`)[0].count),64);
  console.log(JSON.stringify({command:'node --import tsx --test tests/proposal-cost.test.ts',files:64,queries:count}));
  assert.ok(count<=45,'The 64-file proposal used '+count+' SQL queries');
 }finally{await server.close();}
});

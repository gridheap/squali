import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

// Failure specification: independent publication re-downloads immutable file bodies;
// a reference omits bytes/mode/deletion checks; merges skip content validation;
// source sealing performs one SQL round trip per path instead of bounded batches.
test('source publication reuses admitted blobs and batches metadata for 64 independent changes',async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,source:true,onQuery:()=>queries++});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};
 try{
  await call('/projects',{id:'reuse',name:'Reuse admitted content',files:[{path:'README.md',content:'baseline\n'}]});
  for(let i=0;i<64;i++){await call('/projects/reuse/changes',{id:'agent-'+i,title:'Independent '+i,intent:'Preserve the admitted content identity',files:[{path:'agents/'+i+'.txt',content:'agent '+i+'\n',mode:i%2?'100755':'100644'}]});await call('/projects/reuse/changes/agent-'+i+'/review',{decision:'approved'});}
  const before=(await call('/usage')).source,ids=Array.from({length:64},(_,i)=>'agent-'+i);queries=0;
  const preview=await call('/projects/reuse/preview',{changes:ids});assert.equal(preview.ready,true);assert.equal(preview.files[0].bytes,8);assert.equal(preview.files[0].deleted,false);
  const result=await call('/projects/reuse/publish',{id:'publish',changes:ids,expectedHead:preview.head}),count=queries;
  const after=(await call('/usage')).source;assert.equal(after.reads,before.reads,'Independent selection must not download its already admitted blobs');assert.equal(after.writes,before.writes,'Publication must not rewrite blob bodies');assert.ok(count<100,'Preview and publication used '+count+' SQL queries');
  const file=await call('/projects/reuse/file?path=agents/1.txt');assert.equal(file.content,'agent 1\n');assert.equal(file.mode,'100755');assert.equal((await call('/projects/reuse/source')).changesets,66);
  console.log(JSON.stringify({command:'node --import tsx --test tests/publication-cost.test.ts',changes:64,publication:result.oid,queries:count,extraBlobReads:after.reads-before.reads,extraBlobWrites:after.writes-before.writes}));
 }finally{await server.close();}
});

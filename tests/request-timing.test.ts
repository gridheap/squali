import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
import {startLocal} from '../scripts/local.ts';
import {fileBucket} from '../scripts/source-bucket.ts';

// Failure specification: timings escape authentication, reveal input, mix two
// concurrent requests, omit a failed stage, or turn a replay into another PUT.
// Exercise the real HTTP/SQL/storage seam; only the local R2 adapter adds delay.
test('proposal timing measures request-local stages including failure and replay without extra I/O',async()=>{
 const bucket=fileBucket(await mkdtemp(join(tmpdir(),'squali-timing-')));let puts=0;
 const server=await startLocal({port:0,test:true,source:true,sourceBucket:{...bucket,async put(key,data,options){
  puts++;const content=gunzipSync(data).toString();
  if(content.includes('slow-private-content'))await new Promise(r=>setTimeout(r,180));
  if(content.includes('failed-private-content')){await new Promise(r=>setTimeout(r,60));throw Error('Injected R2 failure');}
  return bucket.put(key,data,options);
 }}});
 const call=async(path:string,input:unknown,profile=true,token='local-admin-test-token')=>{
  const response=await fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(profile?{'x-squali-timing':'1'}:{})},body:JSON.stringify(input)});
  const header=response.headers.get('server-timing');const stages=Object.fromEntries((header??'').split(',').filter(Boolean).map(s=>{const [name,duration]=s.trim().split(';dur=');return [name,Number(duration)];}));
  return {status:response.status,body:await response.json() as any,header,stages};
 };
 try{
  const project=await call('/projects',{id:'timing',name:'Timing',files:[]});assert.equal(project.status,201);
  const input=(id:string,content:string)=>({id,title:'Timing',intent:'Measure storage boundary',base:project.body.head,files:[{path:id+'.txt',content}]});
  const route='/projects/timing/changes';
  const slowInput=input('slow','slow-private-content');const fastInput=input('fast','fast-private-content');
  const [slow,fast]=await Promise.all([call(route,slowInput),call(route,fastInput)]);
  for(const result of [slow,fast]){
   assert.equal(result.status,201,JSON.stringify(result.body));
   for(const stage of ['auth','db_connect','scope','project','lookup','base','journal','build','delta','admission','r2_put','blob_ready','seal','graph','paths','finalize','app'])assert.ok(Number.isFinite(result.stages[stage])&&result.stages[stage]>=0,stage+' missing: '+result.header);
   assert.ok(result.stages.app>=result.stages.r2_put);assert.ok(!result.header!.includes('private-content'));
  }
  assert.ok(slow.stages.r2_put>=170);assert.ok(slow.stages.r2_put-fast.stages.r2_put>=100,'Concurrent traces must be isolated');
  const count=puts;const replay=await call(route,slowInput);assert.equal(replay.status,201);assert.equal(replay.body.oid,slow.body.oid);assert.equal(puts,count);assert.equal(replay.stages.r2_put,undefined);
  const failure=await call(route,input('failure','failed-private-content'));assert.equal(failure.status,503);assert.ok(failure.stages.r2_put>=50);assert.equal(failure.stages.finalize,undefined);
  assert.equal((await call(route,slowInput,false)).header,null);
  assert.equal((await call(route,slowInput,true,'invalid')).header,null);
  console.log(JSON.stringify({command:'node --import tsx --test tests/request-timing.test.ts',slow:slow.stages,fast:fast.stages,replay:replay.stages,failure:failure.stages,externalProviderCalls:0}));
 }finally{await server.close();}
});

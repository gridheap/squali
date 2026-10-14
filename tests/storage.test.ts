import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';
import {r2ObjectCache} from '../src/r2-cache.ts';

test('HTTP immutable reads survive cache-tier restart, isolate credentials and stop on R2 outage',async()=>{
 const records=new Map<string,{bytes:Uint8Array;metadata:any}>();let reads=0,writes=0;let down=false;
 // R2 binding boundary: data persists while Worker/edge process state is replaced.
 const bucket={async get(key:string){reads++;if(down)throw new Error('R2 unavailable');const v=records.get(key);return v?{arrayBuffer:async()=>Uint8Array.from(v.bytes).buffer,httpMetadata:v.metadata}:null;},async put(key:string,value:Uint8Array,options:any){writes++;records.set(key,{bytes:value,metadata:options.httpMetadata});return {};}};
 const durableCache=(sql:any)=>r2ObjectCache(bucket,sql,{reads:100,writes:30});
 let server=await startLocal({port:0,test:true,durableCache});
 const call=async(path:string,body?:unknown,token='local-admin-test-token')=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  await call('/projects',{id:'durable',name:'Durable objects',files:[{path:'src/one.ts',content:'export const one = 1;\n'},{path:'src/two.ts',content:'export const two = 2;\n'}]});
  const original=await call('/projects/durable/file?path=src/one.ts');assert.equal(original.status,200);assert.equal(original.body.content,'export const one = 1;\n');assert.ok(writes>0);
  const meter=(await call('/usage')).body.attempts;const writeCount=writes;const dir=server.dir;await server.close();server=await startLocal({port:0,test:true,directory:dir,durableCache});
  const before=reads;const denied=await call('/projects/durable/file?path=src/one.ts',undefined,'invalid');assert.equal(denied.status,401);assert.equal(reads,before,'Auth runs before every cache tier');
  const cached=await call('/projects/durable/file?path=src/one.ts&ref='+original.body.ref);assert.deepEqual(cached.body,original.body);assert.equal(writes,writeCount,'Known immutable data is not re-uploaded');assert.equal((await call('/usage')).body.attempts,meter,'Cold edge cache reads R2 without touching Artifacts');
  await server.close();server=await startLocal({port:0,test:true,directory:dir,durableCache});down=true;
  const failed=await call('/projects/durable/file?path=src/one.ts&ref='+original.body.ref);assert.equal(failed.status,503);assert.equal((await call('/usage')).body.attempts,meter,'R2 failure cannot fan out to the origin');
  const usage=(await call('/usage')).body;assert.ok(usage.cache.reservedReads>=reads);assert.ok(usage.cache.reservedWrites>=writes);
  console.log(JSON.stringify({command:'pnpm test:storage',persistentObjects:records.size,reads,writes,restartedWorkers:2,originCallsOnRestart:0,authBeforeCache:true,outageDoesNotFanOut:true}));
 }finally{await server.close();}
});

test('an interrupted R2 upload cannot repeatedly refill from Artifacts after Worker restart',async()=>{
 let writes=0;const bucket={async get(){return null;},async put(){writes++;throw new Error('Upload unavailable');}};
 const durableCache=(sql:any)=>r2ObjectCache(bucket,sql,{reads:100,writes:30});let server=await startLocal({port:0,test:true,durableCache});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'upload-outage',name:'Upload failure',files:[{path:'file.txt',content:'content'}]});const path='/projects/upload-outage/file?path=file.txt&ref='+p.body.head;
  assert.equal((await call(path)).status,503);const used=(await call('/usage')).body.attempts;assert.equal(writes,1);const dir=server.dir;await server.close();server=await startLocal({port:0,test:true,directory:dir,durableCache});
  assert.equal((await call(path)).status,503);assert.equal((await call('/usage')).body.attempts,used,'An outstanding cache claim stops repeated origin reads');assert.equal(writes,1);
  console.log(JSON.stringify({command:'pnpm test:storage',failedUploads:1,repeatedOriginCalls:0,persistentAdmission:true}));
 }finally{await server.close();}
});

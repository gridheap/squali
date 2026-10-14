import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {startLocal} from '../scripts/local.ts';

// Failure specification: a slow object stalls every later wave; concurrency
// exceeds Workers' six pending connection allowance; replay duplicates writes.
test('source upload fills six bounded slots without waiting for an entire wave',async()=>{
 let active=0,peak=0,puts=0,firstFinished=false,passedSlowObject=false,release!:()=>void;
 const blocked=new Promise<void>(done=>{release=done;});let timer:ReturnType<typeof setTimeout>|undefined;
 const bucket={async put(){const index=puts++;active++;peak=Math.max(peak,active);if(index===8){passedSlowObject=!firstFinished;release();}if(index===0){timer=setTimeout(()=>release(),5000);await blocked;firstFinished=true;}else await new Promise(done=>setTimeout(done,2));active--;},async head(){return null;},async get(){return null;}};
 const server=await startLocal({port:0,test:true,source:true,sourceBucket:bucket});
 const post=(path:string,data:unknown)=>fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify(data)});
 try{
  assert.equal((await post('/projects',{id:'slots',name:'Bounded upload slots',storage:'source',import:true,files:[]})).status,201);
  const objects=Array.from({length:24},(_,i)=>{const bytes=Buffer.from('independent object '+i+'\n');return {oid:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),type:'blob',encoding:'gzip',body:gzipSync(bytes).toString('base64')};});
  const result=await post('/projects/slots/source/objects',{objects});assert.equal(result.status,200,await result.text());assert.equal(puts,24);
  assert.equal(Number((await server.sql`SELECT attempts FROM weave_source_usage WHERE kind='writes'`)[0].attempts),24);
  assert.equal((await post('/projects/slots/source/objects',{objects})).status,200);assert.equal(puts,24,'Completed replay makes no R2 puts');
  console.log(JSON.stringify({command:'node --import tsx --test tests/source-upload-pool.test.ts',objects:24,peak,passedSlowObject,puts}));
  assert.ok(peak<=6,'At most six R2 operations may be outstanding');assert.equal(passedSlowObject,true,'A slow first object must not block later ready slots');
 }finally{clearTimeout(timer);release();await server.close();}
});

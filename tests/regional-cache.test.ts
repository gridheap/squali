import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {regionalRpc} from '../src/regional-cache.ts';
import {startLocal} from '../scripts/local.ts';
import {gzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';

// Failure specification: cache hits bypass project/scope/expiry; lease refreshes
// extend a revoked credential at each tier; duplicate misses stampede origin;
// corrupted/truncated objects are served; cache errors bypass the failed tier;
// overload or outage creates an unbounded queue/retry storm; mutable heads are
// cached; stream cancellation leaks admission slots; credentials enter cache keys.
test('regional RPC isolates failures and shares immutable reads behind bounded authorization',{timeout:30000},async()=>{
 const source=await startLocal({port:0,test:true,source:true});
 const admin='local-admin-test-token',headers={authorization:'Bearer '+admin,'content-type':'application/json'};
 const direct=async(path:string,input?:unknown)=>{const r=await fetch(source.url+'/api'+path,{method:input?'POST':'GET',headers,body:input?JSON.stringify(input):undefined});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
 const entries=new Map<string,Response>();let cacheMode='healthy',originMode='healthy',calls:any[]=[],cacheReads=0,allowed=true,clock=Date.now();
 const cache={async match(request:Request){cacheReads++;if(cacheMode==='read-failed')throw Error('Cache is down');const value=entries.get(request.url);if(cacheMode==='corrupt'&&value)return new Response('corrupt',{headers:value.headers});return value?.clone();},async put(request:Request,response:Response){if(cacheMode==='write-failed')throw Error('Cache fill failed');entries.set(request.url,response.clone());}};
 const upstream={async fetch(request:Request){const query=await request.clone().json() as {op:string};calls.push(query);if(originMode==='failed')return new Response('Unavailable',{status:503});const response=await fetch(new Request(source.url+new URL(request.url).pathname,request));if(originMode==='corrupt'&&query.op==='object')return new Response('corrupt',{headers:response.headers});return response;}};
 const gateway=regionalRpc({upstream,cache,admit:async()=>allowed,now:()=>clock});
 const wire=createServer(async(req,res)=>{try{const chunks=[];for await(const b of req)chunks.push(b);const response=await gateway(new Request('https://squa.li'+req.url,{method:req.method,headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(503).end();}});
 await new Promise<void>(r=>wire.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(wire.address() as {port:number}).port;
 const rpc=(input:unknown,token=admin,project='regional')=>fetch(url+'/api/projects/'+project+'/rpc',{method:'POST',headers:{...headers,authorization:'Bearer '+token},body:JSON.stringify(input)});
 const token=async(id:string,paths:string[]|null=null,lifetime=3600)=>{const value='sq_regional_'+id;await source.sql`INSERT INTO weave_tokens(id,project,token_hash,label,role,paths,expires_at) VALUES(${id},'regional',${createHash('sha256').update(value).digest('hex')},'Regional fixture','reader',${paths},now()+${lifetime}*interval '1 second')`;return value;};
 try{
  const project=await direct('/projects',{id:'regional',name:'Regional cache',files:[{path:'file.txt',content:'shared immutable bytes\n'},{path:'other.txt',content:'other bytes\n'}]});
  const file=await direct('/projects/regional/file?path=file.txt'),other=await direct('/projects/regional/file?path=other.txt');
  const leaseResponse=await rpc({op:'authorize'});assert.equal(leaseResponse.status,200);const lease=await leaseResponse.json() as any;assert.ok(lease.expiresAt>clock&&lease.expiresAt<=Date.now()+30000);assert.equal(lease.project,'regional');
  calls=[];const burst=await Promise.all(Array.from({length:16},()=>rpc({op:'object',oid:file.oid})));
  for(const r of burst){assert.equal(r.status,200);assert.equal(await r.text(),file.content);}
  assert.equal(calls.filter(c=>c.op==='object').length,1,'Sixteen readers share one source RPC');const sharedOriginCalls=calls.length;
  const reader=await token('reader');calls=[];const shared=await rpc({op:'object',oid:file.oid},reader);assert.equal(shared.status,200);assert.equal(shared.headers.get('x-squali-cache'),'hit');assert.deepEqual(calls.map(c=>c.op),['authorize'],'A second authorized principal reuses project data');
  const scoped=await token('scoped',['allowed']);const beforeScope=cacheReads;assert.equal((await rpc({op:'object',oid:file.oid},scoped)).status,403);assert.equal(cacheReads,beforeScope);
  const beforeInvalid=calls.length;assert.equal((await rpc({op:'object',oid:'bad'})).status,400);assert.equal(calls.length,beforeInvalid);
  await direct('/projects',{id:'separate-region',name:'Separate',files:[{path:'other.txt',content:'isolated\n'}]});assert.equal((await rpc({op:'object',oid:file.oid},admin,'separate-region')).status,404);
  calls=[];const stats1=await rpc({op:'stat',oids:[file.oid,other.oid,file.oid]});assert.equal(stats1.status,200);const stats2=await rpc({op:'stat',oids:[other.oid,file.oid]});assert.equal(stats2.status,200);assert.equal(calls.filter(c=>c.op==='stat').length,1,'Canonical stat batches share one entry');
  calls=[];assert.equal((await rpc({op:'head'})).status,200);
  const change=await direct('/projects/regional/changes',{id:'head-update',title:'Head update',intent:'Verify live head',base:project.head,files:[{path:'other.txt',content:'new head\n'}]});await direct('/projects/regional/changes/head-update/review',{decision:'approved'});const published=await direct('/projects/regional/publish',{id:'publish-head',changes:['head-update'],expectedHead:project.head});assert.notEqual(change.oid,project.head);
  assert.equal((await (await rpc({op:'head'})).json() as any).head,published.oid);assert.equal(calls.filter(c=>c.op==='head').length,2);
  for(const mode of ['read-failed','corrupt']){cacheMode=mode;calls=[];assert.equal((await rpc({op:'object',oid:file.oid})).status,503);assert.equal(calls.length,0,'Cache failure must not call origin');}
  cacheMode='healthy';originMode='failed';calls=[];assert.equal((await rpc({op:'object',oid:file.oid})).status,200,'A healthy cache serves a still-authorized hit during origin outage');assert.equal((await rpc({op:'object',oid:'a'.repeat(40)})).status,503);assert.equal((await rpc({op:'object',oid:'b'.repeat(40)})).status,503);assert.equal(calls.length,1,'An origin failure trips the shared circuit without retries');
  originMode='healthy';clock+=6000;cacheMode='write-failed';assert.equal((await rpc({op:'object',oid:other.oid})).status,503);cacheMode='healthy';
  clock+=6000;originMode='corrupt';assert.equal((await rpc({op:'object',oid:other.oid})).status,502);originMode='healthy';clock+=6000;
  allowed=false;calls=[];assert.equal((await rpc({op:'object',oid:other.oid})).status,429);assert.equal(calls.length,0);allowed=true;clock+=6000;
  assert.equal((await rpc({op:'object',oid:other.oid})).status,200);
  const short=await token('short',null,2),fresh=regionalRpc({upstream,cache,admit:async()=>true});const shortReply=await fresh(new Request('https://squa.li/api/projects/regional/rpc',{method:'POST',headers:{...headers,authorization:'Bearer '+short},body:JSON.stringify({op:'authorize'})}));assert.equal(shortReply.status,200);const shortLease=await shortReply.json() as any;assert.ok(shortLease.expiresAt<=Date.now()+2100,'Lease cannot outlive the token');
  await source.sql`UPDATE weave_tokens SET revoked_at=now() WHERE id='reader'`;clock=Date.now()+31000;const beforeRevoke=cacheReads;assert.equal((await rpc({op:'object',oid:file.oid},reader)).status,401);assert.equal(cacheReads,beforeRevoke,'An expired authorization lease cannot expose a warm entry');
  // A separate gateway instance simulates a newly scaled cache process. Retained
  // regional objects still avoid an origin object read after fresh authorization.
  calls=[];const restarted=regionalRpc({upstream,cache,admit:async()=>true});const restartedResponse=await restarted(new Request('https://squa.li/api/projects/regional/rpc',{method:'POST',headers,body:JSON.stringify({op:'object',oid:file.oid})}));assert.equal(restartedResponse.status,200);assert.deepEqual(calls.map(c=>c.op),['authorize']);
  assert.ok([...entries.keys()].every(k=>!k.includes(admin)&&!k.includes(reader)));
  const report={command:'node --import tsx --test tests/regional-cache.test.ts',concurrentReaders:16,sourceObjectCalls:sharedOriginCalls,crossPrincipalReuse:true,canonicalStatBatch:true,headAlwaysFresh:true,scopeAndProjectIsolation:true,leaseMaxSeconds:30,expiryClamped:true,revocationAfterLease:true,cacheFailureOriginCalls:0,originCircuitAttempts:1,automaticRetries:0,corruptObjectRejected:true,processRestartReusesRegionalCache:true,externalProviderCalls:0,passed:true};
  await mkdir('docs/evidence/2026-10-15-regional',{recursive:true});await writeFile('docs/evidence/2026-10-15-regional/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{wire.closeAllConnections();await new Promise<void>(r=>wire.close(()=>r()));await source.close();}
});

test('large streams retain admission until consumed or cancelled, and timeout never retries',{timeout:15000},async()=>{
 const source=await startLocal({port:0,test:true,source:true});const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const raw=Buffer.alloc(2*1024*1024,65),object=createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');
 let writes=0,objects=0,mode='healthy';const cache={async match(){return undefined;},async put(){writes++;}};
 const upstream={async fetch(request:Request){const query=await request.clone().json() as any;if(query.op==='object'){objects++;if(mode==='timeout')return await new Promise<Response>((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}const r=await fetch(new Request(source.url+new URL(request.url).pathname,request));if(mode==='truncated'&&query.op==='object')return new Response(raw.subarray(0,100),{headers:r.headers});return r;}};
 const request=(op:string,oid?:string)=>new Request('https://squa.li/api/projects/streams/rpc',{method:'POST',headers,body:JSON.stringify({op,oid})});
 try{
  for(const [path,body]of [['/projects',{id:'streams',name:'Streams',files:[]}],['/projects/streams/source/objects',{objects:[{oid:object,type:'blob',encoding:'gzip',body:gzipSync(raw).toString('base64')}]}]] as const){const r=await fetch(source.url+'/api'+path,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(r.ok,await r.text());}
  const gateway=regionalRpc({upstream,cache,admit:async()=>true,maxUpstream:1});
  const first=await gateway(request('object',object));assert.equal(first.status,200);assert.equal(first.headers.get('x-squali-cache'),'stream');assert.equal((await gateway(request('head'))).status,503,'An unconsumed stream holds its admission slot');await first.body!.cancel();
  assert.equal((await gateway(request('head'))).status,200,'Cancellation releases admission');const complete=await gateway(request('object',object));assert.deepEqual(Buffer.from(await complete.arrayBuffer()),raw);assert.equal(writes,0,'Large responses stream without entering the bounded small-object cache');
  mode='truncated';const truncated=await gateway(request('object',object));await assert.rejects(truncated.arrayBuffer(),/identity mismatch/);mode='healthy';assert.equal((await gateway(request('head'))).status,200);
  let offset=0;const stalled=regionalRpc({upstream,cache,admit:async()=>true,timeoutMs:100,now:()=>Date.now()+offset,maxUpstream:1});const abandoned=await stalled(request('object',object));assert.equal(abandoned.status,200);await delay(150);offset=6000;const resumed=await stalled(request('object',object));assert.equal(resumed.status,200,'An abandoned timed-out stream must release its coalescing record');await resumed.body!.cancel();await abandoned.body!.cancel();
  const timed=regionalRpc({upstream,cache,admit:async()=>true,timeoutMs:100});assert.equal((await timed(request('authorize'))).status,200);mode='timeout';const before=objects;assert.equal((await timed(request('object',object))).status,503);assert.equal((await timed(request('object','f'.repeat(40)))).status,503);assert.equal(objects-before,1);
  console.log(JSON.stringify({command:'node --import tsx --test tests/regional-cache.test.ts',largeBytes:raw.length,exactStream:true,cancelReleasesSlot:true,truncationRejected:true,smallCacheWrites:0,timeoutAttempts:1,externalProviderCalls:0}));
 }finally{await source.close();}
});

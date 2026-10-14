import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';

// Failure specification: warm immutable reads still query origin metadata;
// commit/tree/RPC use incompatible cache records; corrupt data escapes hashing;
// a failed cache fans out to origin; cache hits bypass scope or revocation;
// a project can read another project's admitted object through a shared cache.
test('immutable HTTP reads share validated cache records without repeated source SQL, while authorization stays live',async()=>{
 const entries=new Map<string,unknown>();let mode='healthy',cacheReads=0,sourceReads=0;
 const cache={async get(key:string){cacheReads++;if(mode==='get-failed')throw Error('Cache unavailable');const value=entries.get(key);if(mode==='corrupt'&&value instanceof Uint8Array){const changed=Buffer.from(value);changed[changed.length-1]^=1;return changed;}return value;},async set(key:string,value:unknown){if(mode==='set-failed')throw Error('Cache fill unavailable');entries.set(key,value);}};
 const server=await startLocal({port:0,test:true,source:true,sourceCache:cache,onQuery:q=>{if(/^SELECT/i.test(q)&&q.includes('weave_source_objects'))sourceReads++;}});
 const call=(path:string,body?:unknown,token='local-admin-test-token')=>fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const json=async(path:string,body?:unknown)=>{const r=await call(path,body);const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};
 try{
  const p=await json('/projects',{id:'cache',name:'Immutable cache',files:[{path:'src/deep/file.txt',content:'Private immutable source\n'},{path:'other.txt',content:'Other\n'}]});
  const rpc=(oid:string,token?:string,project='cache')=>call('/projects/'+project+'/rpc',{op:'object',oid},token);
  entries.clear();sourceReads=0;const first=await rpc(p.head);assert.equal(first.status,200);const commit=Buffer.from(await first.arrayBuffer()),tree=commit.toString().match(/^tree ([a-f0-9]{40})$/m)![1];const coldCommitQueries=sourceReads;
  assert.equal((await rpc(tree)).status,200);const file=await json('/projects/cache/file?path=src/deep/file.txt');assert.equal(file.content,'Private immutable source\n');
  const usage=(await json('/usage')).source;sourceReads=0;
  for(const oid of [p.head,tree,file.oid]){const r=await rpc(oid);assert.equal(r.status,200);const raw=Buffer.from(await r.arrayBuffer());assert.equal(createHash('sha1').update(`${r.headers.get('x-squali-type')} ${raw.length}\0`).update(raw).digest('hex'),oid);}
  assert.equal((await json('/projects/cache/file?path=src/deep/file.txt')).content,file.content);const warmSourceQueries=sourceReads;
  assert.equal(warmSourceQueries,0,'Warm HTTP commit, directory and file reads should not query immutable source rows');
  assert.equal((await json('/usage')).source.reads,usage.reads,'Warm reads must not download R2 blobs');
  for(const failure of ['get-failed','corrupt']){mode=failure;sourceReads=0;const r=await rpc(p.head);assert.equal(r.status,503,await r.text());assert.equal(sourceReads,0,'Failed cache must not query origin');}
  mode='healthy';const beforeDenied=cacheReads;
  assert.equal((await rpc(p.head,'invalid')).status,401);assert.equal(cacheReads,beforeDenied,'Authentication precedes cache');
  const token='sq_local_source_cache_reader';await server.sql`INSERT INTO weave_tokens(id,project,token_hash,label,role,expires_at,paths) VALUES('cache-reader','cache',${createHash('sha256').update(token).digest('hex')},'Local scoped fixture','reader',now()+interval '1 hour',${['src']})`;
  assert.equal((await call('/projects/cache/file?path=src/deep/file.txt',undefined,token)).status,200);const beforeScope=cacheReads;
  assert.equal((await rpc(p.head,token)).status,403);assert.equal((await call('/projects/cache/file?path=other.txt',undefined,token)).status,403);assert.equal(cacheReads,beforeScope);
  await server.sql`UPDATE weave_tokens SET revoked_at=now() WHERE id='cache-reader'`;assert.equal((await call('/projects/cache/file?path=src/deep/file.txt',undefined,token)).status,401);assert.equal(cacheReads,beforeScope,'Revoked credentials cannot use warm cache');
  await json('/projects',{id:'separate',name:'Separate source',files:[{path:'other.txt',content:'Separate\n'}]});assert.equal((await rpc(file.oid,undefined,'separate')).status,404,'Another project cannot use this object cache entry');
  entries.clear();mode='set-failed';const failedFill=await rpc(p.head);assert.equal(failedFill.status,503,await failedFill.text());
  mode='healthy';assert.equal((await rpc(p.head)).status,200);
  const report={command:'node --import tsx --test tests/source-cache.test.ts',coldCommitQueries,warmSourceQueries,warmR2Reads:0,cacheFailureNoOrigin:true,corruptionRejected:true,scopeAndRevocationLive:true,projectIsolation:true};
  await writeFile('docs/evidence/2026-10-15-source/immutable-source-cache.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await server.close();}
});

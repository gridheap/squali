import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

// Public seam: authenticated HTTP proposal, replay, changeset and publication.
// Failure specification: a one-file edit performs excessive database round trips;
// unchanged content is transferred again; a retry writes a second blob/event;
// reducing transactions exposes a half-prepared proposal or moves main early.
// SQL counts are a resource budget for this workload, not a required query plan.
test('one-file source proposals keep database work bounded and replay without storage writes',async()=>{
 let queries:string[]=[];
 const server=await startLocal({port:0,test:true,source:true,poolSize:1,onQuery:q=>queries.push(q)});
 const call=async(path:string,body?:unknown)=>{
  const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json() as any};
 };
 try{
  const p=await call('/projects',{id:'proposal-cost',name:'Proposal cost',files:Array.from({length:64},(_,i)=>({path:'src/file-'+i+'.txt',content:'unchanged '+i+'\n'}))});assert.equal(p.status,201,JSON.stringify(p.body));
  const before=(await call('/usage')).body;
  const input={id:'one-edit',title:'One edit',intent:'Bounded incremental write',base:p.body.head,files:[{path:'src/file-31.txt',content:'one changed file\n'}]};
  queries=[];const start=performance.now();const proposal=await call('/projects/proposal-cost/changes',input);const elapsedMs=performance.now()-start,statements=queries.slice();
  assert.equal(proposal.status,201,JSON.stringify(proposal.body));assert.equal(proposal.body.status,'proposed');assert.equal(proposal.body.files.length,1);
  const after=(await call('/usage')).body;
  const record={command:'node --import tsx --test tests/write-path.test.ts',files:64,editedFiles:1,sqlStatements:statements.length,elapsedMs,sourceReads:after.source.reads-before.source.reads,sourceWrites:after.source.writes-before.source.writes,externalProviderCalls:0,statements};
  console.log(JSON.stringify(record));
  assert.equal(record.sourceWrites,1);assert.equal(record.sourceReads,0);
  assert.equal((await call('/projects/proposal-cost')).body.head,p.body.head);
  const delta=(await call('/projects/proposal-cost/changesets/'+proposal.body.oid)).body;assert.equal(delta.files.length,1);assert.equal(delta.files[0].path,'src/file-31.txt');
  const replay=await call('/projects/proposal-cost/changes',input);assert.deepEqual(replay,proposal);assert.deepEqual((await call('/usage')).body,after);
  assert.equal((await call('/projects/proposal-cost/changes',{...input,title:'Changed retry'})).status,409);
  assert.ok(statements.length<=28,`One-file proposal budget: at most 28 SQL statements, observed ${statements.length}`);
 }finally{await server.close();}
});

// Failure specification: repository-byte rejection consumes the shared write
// allowance, or concurrent requests overspend the last available reservations.
test('repository-byte rejection is recoverable and concurrent callers cannot overspend the write budget',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:8});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'quota-race',name:'Quota race',files:[]});assert.equal(p.status,201);
  const before=(await call('/usage')).body.source;
  const [saved]=await server.sql`SELECT bytes FROM weave_source_bytes WHERE project='quota-race'`;
  await server.sql`UPDATE weave_source_bytes SET bytes=107374182400 WHERE project='quota-race'`;
  const input={id:'byte-limit',title:'Byte limit',intent:'Recover admission',base:p.body.head,files:[{path:'byte-limit',content:'retained byte allowance\n'}]};
  assert.equal((await call('/projects/quota-race/changes',input)).status,413);
  assert.deepEqual((await call('/usage')).body.source,before);
  await server.sql`UPDATE weave_source_bytes SET bytes=${saved.bytes} WHERE project='quota-race'`;
  assert.equal((await call('/projects/quota-race/changes',input)).status,201);
  const month=new Date().toISOString().slice(0,7);
  await server.sql`UPDATE weave_source_usage SET attempts=999997 WHERE month=${month} AND kind='writes'`;
  const responses=await Promise.all(Array.from({length:8},(_,i)=>call('/projects/quota-race/changes',{...input,id:'race-'+i,files:[{path:'race-'+i,content:'unique race '+i+'\n'}]})));
  assert.equal(responses.filter(r=>r.status===201).length,3);assert.equal(responses.filter(r=>r.status===429).length,5);
  assert.equal((await call('/usage')).body.source.writes,1000000);
  assert.equal((await call('/projects/quota-race/changes')).body.changes.length,4);
  console.log(JSON.stringify({command:'node --import tsx --test tests/write-path.test.ts',byteQuotaRollback:true,concurrentAttempts:8,lastReservations:3,accepted:3,denied:5,externalProviderCalls:0}));
 }finally{await server.close();}
});

// Failure specification: a rejected write budget leaves uploading claims that
// prevent an explicit retry even though no object PUT was ever dispatched.
test('source write admission rejects the whole batch before claiming blobs when its budget is insufficient',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:1});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'admission-cost',name:'Atomic admission',files:[]});assert.equal(p.status,201);
  const month=new Date().toISOString().slice(0,7);
  await server.sql`INSERT INTO weave_source_usage(month,kind,attempts) VALUES(${month},'writes',999999) ON CONFLICT(month,kind) DO UPDATE SET attempts=999999`;
  const input={id:'budget',title:'Budget',intent:'All-or-nothing admission',base:p.body.head,files:[{path:'a',content:'budget a'},{path:'b',content:'budget b'}]};
  const denied=await call('/projects/admission-cost/changes',input);assert.equal(denied.status,429,JSON.stringify(denied.body));
  assert.equal((await call('/usage')).body.source.writes,999999);
  assert.equal((await call('/projects/admission-cost/changes')).body.changes.length,0);
  // Local fault fixture only: simulate available allowance without waiting for
  // a month rollover. Production limits are never raised by this test.
  await server.sql`UPDATE weave_source_usage SET attempts=0 WHERE month=${month} AND kind='writes'`;
  const recovered=await call('/projects/admission-cost/changes',input);assert.equal(recovered.status,201,JSON.stringify(recovered.body));
  assert.equal((await call('/usage')).body.source.writes,2);
  console.log(JSON.stringify({command:'node --import tsx --test tests/write-path.test.ts',budgetDeniedBeforePut:true,explicitRetryRecovered:true,acceptedBlobWrites:2,externalProviderCalls:0}));
 }finally{await server.close();}
});

// Failure specification: a failed audit insert leaves a visible proposal without
// its paths/event; simultaneous retries emit duplicate events or upload again.
test('proposal finalization rolls back its visible state and concurrent recovery emits one event',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:4});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'proposal-recovery',name:'Proposal recovery',files:[{path:'file.txt',content:'before\n'}]});assert.equal(p.status,201);
  const before=(await call('/usage')).body.source;
  await server.sql.unsafe("CREATE FUNCTION reject_proposal_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='change.proposed' THEN RAISE EXCEPTION 'Injected event write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_event BEFORE INSERT ON weave_events FOR EACH ROW EXECUTE FUNCTION reject_proposal_event()");
  const input={id:'recover',title:'Recover',intent:'Atomic finalization',base:p.body.head,files:[{path:'file.txt',content:'after\n'}]};
  assert.equal((await call('/projects/proposal-recovery/changes',input)).status,500);
  assert.equal((await call('/projects/proposal-recovery/changes')).body.changes.length,0);
  assert.equal((await call('/projects/proposal-recovery/events')).body.events.filter((e:any)=>e.kind==='change.proposed').length,0);
  await server.sql.unsafe('DROP TRIGGER fail_event ON weave_events');
  const retries=await Promise.all(Array.from({length:8},()=>call('/projects/proposal-recovery/changes',input)));
  for(const r of retries)assert.equal(r.status,201,JSON.stringify(r.body));
  assert.equal(new Set(retries.map(r=>r.body.oid)).size,1);
  assert.equal((await call('/projects/proposal-recovery/changes')).body.changes.length,1);
  assert.equal((await call('/projects/proposal-recovery/events')).body.events.filter((e:any)=>e.kind==='change.proposed').length,1);
  const after=(await call('/usage')).body.source;assert.equal(after.writes-before.writes,1);assert.equal(after.reads-before.reads,0);
  assert.equal((await call('/projects/proposal-recovery')).body.head,p.body.head);
  console.log(JSON.stringify({command:'node --import tsx --test tests/write-path.test.ts',injectedAuditFailure:true,concurrentRetries:8,proposalEvents:1,blobWrites:1,externalProviderCalls:0}));
 }finally{await server.close();}
});

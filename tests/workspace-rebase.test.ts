import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

// Failure specification: dirty edits overwrite upstream changes; planning moves
// main or creates proposals/blobs; conflicts lose their three sides; retry drifts;
// no-op edits overwrite target modes; unsupported paths or resolutions escape.
test('dirty workspace rebase is a deterministic server plan with no source writes',async()=>{
 const server=await startLocal({port:0,test:true,source:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,value:await r.json() as any};};
 try{
  const lines=Array.from({length:12},(_,i)=>'line '+i),local=[...lines],remote=[...lines];local[10]='local';remote[0]='remote';
  const project=(await call('/projects',{id:'dirty',name:'Dirty workspace',files:[{path:'text',content:lines.join('\n')+'\n'},{path:'delete',content:'remove\n'},{path:'mode',content:'same\n'}]})).value;
  const onto=(await call('/projects/dirty/changes',{id:'upstream',title:'Upstream',intent:'Fixture',base:project.head,files:[{path:'text',content:remote.join('\n')+'\n'},{path:'mode',content:'same\n',mode:'100755'},{path:'remote',content:'remote\n'}]})).value.oid;
  const before=(await call('/usage')).value;
  const request={base:project.head,onto,files:[{path:'text',content:local.join('\n')+'\n',mode:'100644'},{path:'delete',content:null},{path:'new',content:'local\n',mode:'100644'},{path:'mode',content:'same\n',mode:'100644'}]};
  const plan=await call('/projects/dirty/rebase-plan',request);assert.equal(plan.status,200,JSON.stringify(plan.value));
  const merged=[...remote];merged[10]='local';assert.deepEqual(plan.value,{base:project.head,onto,files:[{path:'text',content:merged.join('\n')+'\n',mode:'100644'},{path:'delete',content:null},{path:'new',content:'local\n',mode:'100644'}]});
  assert.deepEqual((await call('/projects/dirty/rebase-plan',request)).value,plan.value);
  assert.equal((await call('/projects/dirty')).value.head,project.head);
  assert.equal((await call('/usage')).value.source.writes,before.source.writes);
  assert.equal((await call('/projects/dirty/changes')).value.changes.length,1);
  const conflictRequest={base:project.head,onto,files:[{path:'text',content:'overlapping\n'}]};
  const conflict=await call('/projects/dirty/rebase-plan',conflictRequest);assert.equal(conflict.status,409);assert.equal(conflict.value.error,'rebase_conflict');assert.equal(conflict.value.details.conflicts[0].target,remote.join('\n')+'\n');
  const resolved=await call('/projects/dirty/rebase-plan',{...conflictRequest,resolutions:[{path:'text',content:'resolved\n'}]});assert.equal(resolved.status,200);assert.equal(resolved.value.files[0].content,'resolved\n');
  const deleted=await call('/projects/dirty/rebase-plan',{...conflictRequest,resolutions:[{path:'text',content:null,mode:'100644'}]});assert.equal(deleted.status,200);assert.deepEqual(deleted.value.files,[{path:'text',content:null}],'Deleted files have no mode in the staged plan');
  assert.equal((await call('/projects/dirty/rebase-plan',{...request,resolutions:[{path:'unrelated',content:'no'}]})).status,400);
  assert.equal((await call('/projects/dirty/rebase-plan',{...request,onto:'main'})).status,400);
  assert.equal((await call('/projects/dirty/rebase-plan',{...request,files:[{path:'../escape',content:'no'}]})).status,400);
  console.log(JSON.stringify({command:'node --import tsx --test tests/workspace-rebase.test.ts',deterministic:true,serverSideMerge:true,conflictsRecoverable:true,sourceWrites:0,mainUnchanged:true}));
 }finally{await server.close();}
});

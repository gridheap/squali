import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';

// Failure specification: every query re-discovers parameter types instead of
// using prepared statements; reused statements bind stale values; PostgreSQL
// text arrays lose their decoder; commit/review transactions mix parameters.
test('HTTP source workflows use prepared SQL and preserve array parameters across repeated queries',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:1});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
 try{
  await call('/projects',{id:'protocol',name:'Prepared SQL',files:[{path:'a.txt',content:'initial A\n'},{path:'b.txt',content:'initial B\n'}]});
  for(const id of ['alpha','beta']){const change=await call('/projects/protocol/changes',{id,title:id,intent:'Preserve bound values',dependencies:id==='beta'?['alpha']:[],files:[{path:id+'.txt',content:'content '+id+'\n'}]});assert.deepEqual(change.dependencies,id==='beta'?['alpha']:[]);await call('/projects/protocol/changes/'+id+'/review',{decision:'approved'});}
  const preview=await call('/projects/protocol/preview',{changes:['beta','alpha']});assert.equal(preview.ready,true);const published=await call('/projects/protocol/publish',{id:'prepared',changes:['beta','alpha'],expectedHead:preview.head});assert.deepEqual(published.changes,['alpha','beta']);
  for(const id of ['alpha','beta','alpha'])assert.equal((await call('/projects/protocol/file?path='+id+'.txt')).content,'content '+id+'\n');
  const canonical=await call('/projects/protocol/changesets/'+published.oid);assert.ok(Array.isArray(canonical.parents));assert.equal(canonical.parents.length,3);
  const rows=await server.sql`SELECT name,from_sql,custom_plans,generic_plans FROM pg_prepared_statements WHERE name<>''`;
  const prepared=rows.filter(row=>!row.from_sql),reused=prepared.filter(row=>Number(row.custom_plans)+Number(row.generic_plans)>1);
  assert.ok(prepared.length>0,'The HTTP database connection must use named prepared statements');assert.ok(reused.length>0,'Repeated queries should reuse prepared protocol statements');
  const report={command:'node --import tsx --test tests/database-protocol.test.ts',preparedStatements:prepared.length,reusedStatements:reused.length,textArraysPreserved:true,differentBoundValuesPreserved:true,publicationParents:canonical.parents.length};await writeFile('docs/evidence/2026-10-15-source/database-protocol.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await server.close();}
});

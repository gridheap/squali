import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

// Failure specification: deep jump ancestors differ from lazy derivation;
// missing parent indexes are mistaken for complete; SQL failure exposes a
// canonical changeset without its indexes; retries duplicate storage writes;
// an eager small submission still pays one network round trip per index step.
test('prepared sealing is bounded, atomic and identical to a lazy rebuild across deep ancestry',async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,source:true,poolSize:1,onQuery:()=>queries++});
 const request=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
 const call=async(path:string,body?:unknown)=>{const r=await request(path,body);assert.ok(r.status<300,JSON.stringify(r));return r.body;};
 try{
  const project=await call('/projects',{id:'seal',name:'Seal',files:[{path:'file',content:'0'}]});let base=project.head;const counts:number[]=[];
  for(let i=1;i<=18;i++){
   if(i===9){await server.sql`DELETE FROM weave_commit_graph WHERE project='seal'`;await server.sql`DELETE FROM weave_derived WHERE project='seal' AND kind='source-paths:v1'`;await server.sql`DELETE FROM weave_source_paths WHERE project='seal'`;}
   queries=0;const result=await call('/projects/seal/changes',{id:'step-'+i,title:'Step',intent:'Ancestry fixture',base,files:[{path:'file',content:String(i)}]});if(i!==9)counts.push(queries);base=result.oid;
  }
  const snapshot=async()=>({graph:await server.sql`SELECT oid,tree,parents,generation,first_depth,linear_span,tree_span,jumps FROM weave_commit_graph WHERE project='seal' ORDER BY oid`,paths:await server.sql`SELECT key,value FROM weave_derived WHERE project='seal' AND kind='source-paths:v1' ORDER BY key`,events:await server.sql`SELECT path,git_oid FROM weave_source_paths WHERE project='seal' ORDER BY path,git_oid`});
  const eager=JSON.parse(JSON.stringify(await snapshot()));const usage=(await call('/usage')).source;
  await server.sql`DELETE FROM weave_commit_graph WHERE project='seal'`;await server.sql`DELETE FROM weave_derived WHERE project='seal' AND kind='source-paths:v1'`;await server.sql`DELETE FROM weave_source_paths WHERE project='seal'`;
  await call('/projects/seal/source/derive',{kind:'indexes',version:1,changesets:[base]});assert.deepEqual(JSON.parse(JSON.stringify(await snapshot())),eager);assert.deepEqual((await call('/usage')).source,usage);
  await server.sql.unsafe("CREATE FUNCTION fail_seal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected path marker failure'; END $$");
  await server.sql.unsafe("CREATE TRIGGER fail_seal BEFORE INSERT ON weave_derived FOR EACH ROW EXECUTE FUNCTION fail_seal()");
  const input={id:'recover',title:'Recover',intent:'Atomic sealing',base,files:[{path:'file',content:'recover'}]};
  const failed=await request('/projects/seal/changes',input);assert.equal(failed.status,500);
  assert.equal(Number((await server.sql`SELECT count(*) FROM weave_changesets WHERE project='seal'`)[0].count),19);
  assert.deepEqual(JSON.parse(JSON.stringify(await snapshot())),eager);
  const written=(await call('/usage')).source.writes;
  await server.sql.unsafe('DROP TRIGGER fail_seal ON weave_derived');assert.equal((await call('/projects/seal/changes',input)).status,'proposed');assert.equal((await call('/usage')).source.writes,written);
  assert.equal((await call('/projects/seal')).head,project.head);
  console.log(JSON.stringify({command:'node --import tsx --test tests/prepared-seal.test.ts',depth:18,counts,atomicFailure:true,lazyMatchesEager:true,missingParentRebuilt:true,retryExtraPuts:0,externalProviderCalls:0}));
  assert.ok(Math.max(...counts)<=16,'Prepared proposal SQL budget exceeded: '+counts.join(','));
 }finally{await server.close();}
});

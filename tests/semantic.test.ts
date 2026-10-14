import test from 'node:test';import assert from 'node:assert/strict';import {startLocal} from '../scripts/local.ts';
test('semantic review accepts comments and JSON formatting, rejects changed execution and hidden directives',async()=>{
 const server=await startLocal({port:0,test:true,source:true,poolSize:1});const call=async(path:string,data?:unknown)=>{const r=await fetch(server.url+'/api'+path,{signal:AbortSignal.timeout(3000),method:data?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  await call('/projects',{id:'semantics',name:'Semantic constraints',storage:'source',files:[{path:'src/payment.js',content:'export function total(n) { return n * 2; }\n'},{path:'config/rates.json',content:'{"usd":2,"nested":{"value":true}}\n'}]});
  const rules=[{prefix:'src',independentReview:false,requireEvidence:false,semantic:'javascript-comments'},{prefix:'config',independentReview:false,requireEvidence:false,semantic:'json-values'}];assert.equal((await call('/projects/semantics/policy',{rules})).status,200);
  const propose=async(id:string,path:string,content:string|null)=>{assert.equal((await call('/projects/semantics/changes',{id,title:id,intent:'Validate a semantic constraint',files:[{path,content}]})).status,201);return call('/projects/semantics/changes/'+id+'/review',{decision:'approved'});};
  assert.equal((await propose('changed','src/payment.js','export function total(n) { return n * 3; }\n')).status,409);
  assert.equal((await propose('directive','src/payment.js','/*#__PURE__*/ export function total(n) { return n * 2; }\n')).status,409);
  assert.equal((await propose('syntax','src/payment.js','export function total( {')).status,409);
  assert.equal((await propose('unsupported','src/types.ts','export const n: number = 1;')).status,409);
  assert.equal((await propose('delete','src/payment.js',null)).status,409);
  assert.equal((await propose('json-change','config/rates.json','{"usd":3,"nested":{"value":true}}')).status,409);
  assert.equal((await propose('duplicate-key','config/rates.json','{"usd":100,"usd":2,"nested":{"value":true}}')).status,409);
  assert.equal((await propose('comments','src/payment.js','// Explain the existing calculation.\nexport function total(n) { /* multiplier */ return n * 2; }\n')).status,200);
  assert.equal((await propose('format','config/rates.json','{\n "nested": {"value":true},\n "usd": 2\n}\n')).status,200);
  const policy=(await call('/projects/semantics/policy')).body;assert.equal(policy.rules[0].semantic,'javascript-comments');const publication=await call('/projects/semantics/publish',{id:'semantic-approved',changes:['comments','format']});assert.equal(publication.status,201,JSON.stringify(publication.body));
  console.log(JSON.stringify({command:'node --import tsx --test tests/semantic.test.ts',javascriptAst:true,commentDirectivesRejected:true,jsonValues:true,duplicateKeysRejected:true,enforcedOnReviewAndPublication:true}));
 }finally{await server.close();}
});

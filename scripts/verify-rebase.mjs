#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const base=(process.env.SQUALI_URL??'https://squa.li').replace(/\/$/,'');
const project=process.env.SQUALI_PROJECT,ref=process.env.SQUALI_REF,id=process.env.SQUALI_REBASE_ID,output=process.env.SQUALI_SMOKE_RESULT;
if(!output||!project||!id||!/^[a-f0-9]{40}$/.test(ref??''))throw Error('Set SQUALI_PROJECT, SQUALI_REF, SQUALI_REBASE_ID and SQUALI_SMOKE_RESULT');
const target={base,project,ref,id};let state;
try{state=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
state??={command:'node scripts/verify-rebase.mjs',target,steps:{},httpAttempts:0};assert.deepEqual(state.target,target);
const save=()=>writeFile(output,JSON.stringify(state,null,2)+'\n',{mode:0o600});
async function call(name,path,body,expected=200){
 if(state.steps[name])return state.steps[name].body;
 assert(state.httpAttempts<7,'Seven-attempt ceiling reached; inspect saved evidence');assert(process.env.SQUALI_TOKEN,'Set SQUALI_TOKEN');
 state.httpAttempts++;await save();
 const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+process.env.SQUALI_TOKEN,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(35000)});
 const value=await response.json();assert.equal(response.status,expected,name+' HTTP status');state.steps[name]={status:response.status,path,...(body?{request:body}:{}),body:value};await save();return value;
}
const before=await call('before','/usage');assert(before.cap-before.attempts>=32);
const prefix='/projects/'+encodeURIComponent(project),initial=await call('head-before',prefix);
const source=await call('source',prefix+'/commit?ref='+ref);assert(source.parents.length,'Use a small non-root fixture');
const result=await call('rebase',prefix+'/rebase',{id,commit:ref,onto:source.parents[0],parent:1,note:'Bounded production rebase acceptance; review required before any publication'},201);
assert.equal(result.status,'proposed');assert.equal(result.reviewer,null);
const rebased=await call('rebased-commit',prefix+'/commit?ref='+result.oid);assert.equal(rebased.tree,source.tree);assert.deepEqual(rebased.parents,[source.parents[0]]);
assert.equal((await call('head-after',prefix)).head,initial.head);
const after=await call('after','/usage');assert(after.attempts-before.attempts<=32);
state.completed??=new Date().toISOString();Object.assign(state,{newArtifactReservations:after.attempts-before.attempts,providerMeasuredCalls:'Unavailable; application reservations are conservative',mainMutations:0,proposalsCreated:1,largeImportTransfers:0,automaticRetries:0});await save();
console.log(JSON.stringify({steps:Object.keys(state.steps),newArtifactReservations:state.newArtifactReservations,mainUnchanged:true,reviewRequired:true,treeMatches:true,proposal:id,usage:after}));

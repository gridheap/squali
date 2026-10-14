#!/usr/bin/env node
// One bounded production acceptance run. Keep its result to avoid duplicate calls.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const base=(process.env.SQUALI_URL??'https://squa.li').replace(/\/$/,'');
const project=process.env.SQUALI_PROJECT,ref=process.env.SQUALI_REF;
const output=process.env.SQUALI_SMOKE_RESULT;
if(!output||!project||!/^[a-f0-9]{40}$/.test(ref??''))throw Error('Set SQUALI_PROJECT, SQUALI_REF and SQUALI_SMOKE_RESULT');
const target={base,project,ref};
let state;try{state=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
state??={command:'node scripts/verify-graph.mjs',target,steps:{},httpAttempts:0};
assert.deepEqual(state.target,target,'Use the saved target; do not reuse a result for another input');
const save=()=>writeFile(output,JSON.stringify(state,null,2)+'\n',{mode:0o600});
async function call(name,path,body,expected=200,reader=false){
 if(state.steps[name])return state.steps[name].body;
 assert(state.httpAttempts<6,'Six-attempt ceiling reached; inspect the saved failure before further work');
 const token=reader?process.env.SQUALI_READER_TOKEN:process.env.SQUALI_TOKEN;
 assert(token,'Supply the required credential through the environment');
 state.httpAttempts++;await save();
 const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(35000)});
 const value=await response.json();
 assert.equal(response.status,expected,name+' returned an unexpected HTTP status');
 state.steps[name]={status:response.status,path,...(body?{request:body}:{}),body:value};await save();return value;
}
const before=await call('before','/usage');assert(before.cap-before.attempts>=32,'Insufficient remaining provider-call budget');
const prefix='/projects/'+encodeURIComponent(project);
const indexed=await call('index',prefix+'/index',{ref,limit:8});assert(indexed.complete,'Small fixture did not finish within one bounded step');
assert((await call('status',prefix+'/index?ref='+ref)).complete);
assert.deepEqual((await call('merge-base',prefix+'/merge-base',{left:ref,right:ref})).bases,[ref]);
await call('reader-denied',prefix+'/index',{ref,limit:1},403,true);
const after=await call('after','/usage');assert(after.attempts-before.attempts<=32);
const reused=!!state.completed;
state.completed??=new Date().toISOString();
Object.assign(state,{newArtifactReservations:after.attempts-before.attempts,providerMeasuredCalls:'Unavailable; application reservations are conservative',gitSourceMutations:0,largeImportTransfers:0,automaticRetries:0});
await save();console.log(JSON.stringify({reused,httpAttempts:state.httpAttempts,steps:Object.keys(state.steps),newArtifactReservations:state.newArtifactReservations}));

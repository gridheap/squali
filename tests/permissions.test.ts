import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),domain='permissions.clerk.accounts.dev';

test('directory credentials cannot escape via Git, object batches, metadata or proposal IDs; review policies gate publication',async()=>{
 const server=await startLocal({port:0,test:true,clerk:{publishableKey:'pk_test_'+Buffer.from(domain+'$').toString('base64'),secretKey:'sk_test_fixture',jwtKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()}});
 const now=Math.floor(Date.now()/1000);const input=[{alg:'RS256',typ:'JWT',kid:'fixture'},{iss:'https://'+domain,sub:'user_owner',sid:'session',azp:server.url,iat:now,nbf:now-5,exp:now+300}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');const owner=input+'.'+sign('RSA-SHA256',Buffer.from(input),keys.privateKey).toString('base64url');
 const call=async(path:string,body?:unknown,token=owner)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await r.text();return {status:r.status,body:JSON.parse(text)};};
 try{
  const p=(await call('/projects',{id:'paths',name:'Paths',files:[{path:'docs/guide.md',content:'Guide\n'},{path:'secrets/private.txt',content:'Private source\n'}]})).body;
  const token=(await call('/projects/paths/tokens',{label:'Docs agent',role:'agent',days:1,paths:['docs']})).body.token;assert.ok(token);
  const root=await mkdtemp('work/scoped-cli-');const cli=(scope:string,folder:string,path:string)=>promisify(execFile)('node',['scripts/working-copy.mjs','checkout','paths',root+'/'+folder,path],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:scope,SQUALI_CACHE_DIR:root+'/cache'}});
  await cli(owner,'owner','secrets');await assert.rejects(cli(token,'escape','secrets'),'A warm cache must not bypass a narrower credential');
  await cli(token,'allowed','docs');assert.equal(await readFile(root+'/allowed/docs/guide.md','utf8'),'Guide\n');
  assert.equal((await call('/projects/paths/file?path=secrets/private.txt',undefined,token)).status,403);assert.equal((await call('/projects/paths/blob?path=secrets/private.txt',undefined,token)).status,403);
  assert.equal((await call('/projects/paths/file?path=docs/guide.md',undefined,token)).status,200);
  assert.deepEqual((await call('/projects/paths/tree',undefined,token)).body.entries.map((r:any)=>r.name),['docs']);
  assert.equal((await call('/projects/paths/git/info/refs?service=git-upload-pack',undefined,token)).status,403);
  assert.equal((await call('/projects/paths/objects',{objects:[{type:'commit',oid:p.head}]},token)).status,403);
  assert.equal((await call('/projects/paths/diff',{from:p.head,to:p.head},token)).status,403);
  const hidden=(await call('/projects/paths/changes',{id:'hidden',title:'Secret edit',intent:'Private',files:[{path:'secrets/private.txt',content:'new\n'}]})).body;
  assert.equal((await call('/projects/paths/changes/'+hidden.id,undefined,token)).status,403);assert.deepEqual((await call('/projects/paths/changes',undefined,token)).body.changes,[]);
  assert.equal((await call('/projects/paths/changes',{id:'escape',title:'Escape',intent:'Escape',files:[{path:'secrets/private.txt',content:'wrong'}]},token)).status,403);
  const linked=await call('/projects/paths/changes',{id:'linked',title:'Linked docs',intent:'Depends on private work',dependencies:['hidden'],files:[{path:'docs/linked.md',content:'Linked'}]});assert.equal(linked.status,201);
  const reserved=(await call('/usage')).body.attempts;
  assert.equal((await call('/projects/paths/preview',{changes:['linked']},token)).status,403,'Hidden dependencies are rejected before preview examines their state');
  assert.equal((await call('/usage')).body.attempts,reserved,'Scope is checked before provider access');
  assert.equal((await call('/projects/paths/changes',undefined,token)).body.changes.some((r:any)=>r.id==='linked'),false);
  const scopedReviewer=(await call('/projects/paths/tokens',{label:'Docs reviewer',role:'reviewer',days:1,paths:['docs']})).body.token;
  assert.equal((await call('/projects/paths/publish',{id:'outside-scope',changes:['linked']},scopedReviewer)).status,403);
  const made=await call('/projects/paths/changes',{id:'docs',title:'Docs',intent:'Docs',files:[{path:'docs/guide.md',content:'Improved guide\n'}]},token);assert.equal(made.status,201);
  assert.equal((await call('/projects/paths/policy',{rules:[{prefix:'docs',independentReview:true,requireEvidence:true}]})).status,200);
  assert.equal((await call('/projects/paths/changes/docs/review',{decision:'approved'})).status,409,'Evidence is required');
  const own=await call('/projects/paths/changes',{id:'own',title:'Owner edit',intent:'Docs',context:{evidence:[{command:'check',result:'pass'}]},files:[{path:'docs/guide.md',content:'Owner edit\n'}]});assert.equal(own.status,201);
  assert.equal((await call('/projects/paths/changes/own/review',{decision:'approved'})).status,403,'Sensitive paths require an independent reviewer');
  const passing=await call('/projects/paths/changes',{id:'pass',title:'Checked edit',intent:'Docs',context:{evidence:[{command:'check',result:'pass'}]},files:[{path:'docs/guide.md',content:'Checked edit\n'}]},token);assert.equal(passing.status,201);
  assert.equal((await call('/projects/paths/changes/pass/review',{decision:'approved'})).status,200);
  await call('/projects/paths/policy',{rules:[{prefix:'docs',independentReview:true,requireEvidence:true}]});assert.equal((await call('/projects/paths/publish',{id:'stale-policy',changes:['pass']})).status,409,'Policy updates require renewed approval');
  await call('/projects/paths/changes/pass/review',{decision:'approved'});assert.equal((await call('/projects/paths/publish',{id:'fresh-policy',changes:['pass']})).status,201);
  console.log(JSON.stringify({command:'pnpm test:permissions',directoryBoundary:'docs',escapeRoutesRejected:['file','tree siblings','git','objects','unscoped diff','proposal ID','write'],independentReview:true,evidenceRequired:true,policyChangeInvalidatesApproval:true}));
 }finally{await server.close();}
});

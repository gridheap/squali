import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

let server: Awaited<ReturnType<typeof startLocal>>;
let project: any;
const admin = 'local-admin-test-token';
const agent = 'local-agent-test-token';
async function api(path:string, body?:unknown, token=admin, method?:string) {
  const res=await fetch(server.url+'/api'+path,{method:method??(body===undefined?'GET':'POST'),headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:res.status,body:await res.json() as any};
}
before(async()=>{server=await startLocal({port:0,adminToken:admin,agentToken:agent,test:true});});
after(async()=>{await server?.close();});

test('HTTP auth, workspace creation and sparse reads preserve a real Git repository',async()=>{
  assert.equal((await api('/projects',undefined,'wrong')).status,401);
  assert.equal((await api('/projects',{id:'denied',name:'Denied',files:[]},agent)).status,403);
  const input={id:'sample',name:'Sample workspace',files:[{path:'src/app.ts',content:'export const count = 1;\nexport const label = "Weave";\n'},{path:'README.md',content:'# Sample\n'}]};
  const made=await api('/projects',input);
  assert.equal(made.status,201,JSON.stringify(made.body)); project=made.body;
  assert.match(project.head,/^[a-f0-9]{40}$/);
  assert.deepEqual((await api('/projects',input)).body,project);
  assert.equal((await api('/projects',{...input,name:'different'})).status,409);
  const file=await api('/projects/sample/file?path=src/app.ts&ref='+project.head);
  assert.equal(file.body.content,input.files[0].content);
  assert.equal((await api('/projects/sample/tree?ref='+project.head)).body.entries.length,2);
  assert.equal((await api('/projects/sample/file?path=missing&ref='+project.head)).status,404);
});

test('parallel agent changes preserve context, require review, and publish one Git commit',async()=>{
 const base=project.head;
 const input=(id:string,path:string)=>({id,title:`Update ${path}`,intent:'Independent agent task',base,context:{prompt:'Keep API compatibility',evidence:[{command:'node --test',result:'pass'}]},dependencies:[],files:[{path,content:`export const ${id} = true;\n`}]});
 const results=await Promise.all([api('/projects/sample/changes',input('alpha','src/alpha.ts'),agent),api('/projects/sample/changes',input('beta','src/beta.ts'),agent)]);
 for(const r of results){assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.status,'proposed');assert.equal(r.body.context.prompt,'Keep API compatibility');}
 const repeat=await api('/projects/sample/changes',input('alpha','src/alpha.ts'),agent);assert.equal(repeat.body.oid,results[0].body.oid);
 assert.equal((await api('/projects/sample/changes',{...input('alpha','src/alpha.ts'),title:'Changed'},agent)).status,409);
 assert.equal((await api('/projects/sample/changes/alpha/review',{decision:'approved',note:'Reviewed'},agent)).status,403);
 assert.equal((await api('/projects/sample/publish',{id:'batch-one',changes:['alpha','beta']})).status,409);
 for(const id of ['alpha','beta'])assert.equal((await api(`/projects/sample/changes/${id}/review`,{decision:'approved',note:'Diff and evidence checked'})).status,200);
 const preview=await api('/projects/sample/preview',{changes:['alpha','beta']});assert.equal(preview.body.conflicts.length,0);assert.equal(preview.body.ready,true);
 const published=await api('/projects/sample/publish',{id:'batch-one',changes:['alpha','beta'],expectedHead:preview.body.head});assert.equal(published.status,201,JSON.stringify(published.body));
 assert.equal(published.body.changes.length,2);assert.equal((await api('/projects/sample/publish',{id:'batch-one',changes:['alpha','beta'],expectedHead:preview.body.head})).body.oid,published.body.oid);
 for(const id of ['alpha','beta'])assert.equal((await api(`/projects/sample/file?path=src/${id}.ts&ref=${published.body.oid}`)).body.content,`export const ${id} = true;\n`);
 const detail=await api('/projects/sample/changes/alpha');assert.equal(detail.body.status,'landed');assert.equal(detail.body.diff[0].after,'export const alpha = true;\n');
 project.head=published.body.oid;
});

test('three-way merge accepts separate lines and exposes overlapping edits for explicit revision',async()=>{
 const base=project.head;
 async function propose(id:string,content:string,baseOid=base){const r=await api('/projects/sample/changes',{id,title:id,intent:'Edit app with retained intent',base:baseOid,context:{task:'merge-demo'},files:[{path:'src/app.ts',content}]},agent);assert.equal(r.status,201);await api(`/projects/sample/changes/${id}/review`,{decision:'approved',note:'Reviewed'});}
 await propose('count','export const count = 2;\nexport const label = "Weave";\n');
 await propose('label','export const count = 1;\nexport const label = "Together";\n');
 const plan=await api('/projects/sample/preview',{changes:['count','label']});assert.equal(plan.body.conflicts.length,0,JSON.stringify(plan.body));
 const published=await api('/projects/sample/publish',{id:'batch-lines',changes:['count','label'],expectedHead:plan.body.head});assert.equal(published.status,201,JSON.stringify(published.body));
 assert.equal((await api(`/projects/sample/file?path=src/app.ts&ref=${published.body.oid}`)).body.content,'export const count = 2;\nexport const label = "Together";\n');
 await propose('clash','export const count = 9;\nexport const label = "Weave";\n');
 const conflict=await api('/projects/sample/preview',{changes:['clash']});assert.equal(conflict.body.conflicts[0].path,'src/app.ts');assert.equal(conflict.body.ready,false);
 assert.equal((await api('/projects/sample/publish',{id:'blocked',changes:['clash']})).status,409);
 const revised=await api('/projects/sample/changes/clash/revise',{id:'clash-fixed',files:[{path:'src/app.ts',content:'export const count = 9;\nexport const label = "Together";\n'}],note:'Keep both intended edits'},agent);
 assert.equal(revised.status,201,JSON.stringify(revised.body));assert.equal(revised.body.status,'proposed');assert.equal(revised.body.context.task,'merge-demo');assert.equal(revised.body.context.supersedes,'clash');
 assert.equal((await api('/projects/sample/publish',{id:'too-early',changes:['clash-fixed']})).status,409);
 await api('/projects/sample/changes/clash-fixed/review',{decision:'approved',note:'Resolution reviewed'});
 const fixed=await api('/projects/sample/publish',{id:'batch-fixed',changes:['clash-fixed']});assert.equal(fixed.status,201,JSON.stringify(fixed.body));project.head=fixed.body.oid;
});

test('dependencies, malformed paths, unauthorized writes, and external Git races fail safely',async()=>{
 const payload={id:'dep-a',title:'Dependency A',intent:'Prepare shared capability',files:[{path:'dependency.txt',content:'ready\n'}]};
 assert.equal((await api('/projects/sample/changes',{...payload,id:'bad-path',files:[{path:'../secret',content:'bad'}]},agent)).status,400);
 assert.equal((await api('/projects/sample/changes',{...payload,id:'bad-git',files:[{path:'.git/config',content:'bad'}]},agent)).status,400);
 assert.equal((await api('/projects/sample/changes',{...payload,id:'bad-cycle',dependencies:['bad-cycle']},agent)).status,400);
 assert.equal((await api('/projects/sample/changes',payload,agent)).status,201);
 assert.equal((await api('/projects/sample/changes',{...payload,id:'dep-b',dependencies:['dep-a'],files:[{path:'consumer.txt',content:'uses dependency\n'}]},agent)).status,201);
 await api('/projects/sample/changes/dep-b/review',{decision:'approved',note:'Reviewed'});
 assert.equal((await api('/projects/sample/preview',{changes:['dep-b']})).status,409);
 await api('/projects/sample/changes/dep-a/review',{decision:'approved',note:'Reviewed'});
 const preview=await api('/projects/sample/preview',{changes:['dep-b','dep-a']});assert.deepEqual(preview.body.changes,['dep-a','dep-b']);
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const {readFile,writeFile}=await import('node:fs/promises');
 const clone=server.dir+'/checkout';await exec('git',['clone',project.remote,clone]);
 await writeFile(clone+'/external.txt','native git client\n');await exec('git',['-C',clone,'add','.']);await exec('git',['-C',clone,'-c','user.name=Tester','-c','user.email=test@example.invalid','commit','-m','External change']);await exec('git',['-C',clone,'push','origin','main']);
 assert.equal((await api('/projects/sample/publish',{id:'stale-preview',changes:['dep-a','dep-b'],expectedHead:preview.body.head})).status,409);
 const fresh=await api('/projects/sample/preview',{changes:['dep-b','dep-a']});const published=await api('/projects/sample/publish',{id:'dependencies',changes:['dep-b','dep-a'],expectedHead:fresh.body.head});assert.equal(published.status,201,JSON.stringify(published.body));
 await exec('git',['-C',clone,'pull','--ff-only']);assert.equal(await readFile(clone+'/external.txt','utf8'),'native git client\n');assert.equal(await readFile(clone+'/consumer.txt','utf8'),'uses dependency\n');
 await exec('git',['-C',clone,'fsck','--full']);project.head=published.body.oid;
});

test('a lost push acknowledgement recovers the exact publication without duplicating Git history',async()=>{
 const fixture=await startLocal({port:0,test:true,failPublicationAckOnce:true});
 try{
  const call=async(path:string,b?:unknown)=>{const r=await fetch(fixture.url+'/api'+path,{method:b?'POST':'GET',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json() as any};};
  await call('/projects',{id:'recovery',name:'Recovery',files:[{path:'a.txt',content:'a\n'}]});
  await call('/projects/recovery/changes',{id:'one',title:'One',intent:'Recovery check',files:[{path:'b.txt',content:'b\n'}]});await call('/projects/recovery/changes/one/review',{decision:'approved'});
  const input={id:'recover-once',changes:['one']};assert.equal((await call('/projects/recovery/publish',input)).status,500);
  const recovered=await call('/projects/recovery/publish',input);assert.equal(recovered.status,201,JSON.stringify(recovered.data));assert.equal(recovered.data.state,'published');
  assert.equal((await call('/projects/recovery/publish',input)).data.oid,recovered.data.oid);
  assert.equal((await call('/projects/recovery/publications')).data.publications.length,1);
 }finally{await fixture.close();}
});

test('persistent operation limits stop work before the next provider call',async()=>{
 const fixture=await startLocal({port:0,test:true,callCap:2});
 try{
  const r=await fetch(fixture.url+'/api/projects',{method:'POST',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:JSON.stringify({id:'capped',name:'Cap',files:[]})});assert.equal(r.status,429);
  const usage=await fetch(fixture.url+'/api/usage',{headers:{authorization:`Bearer ${admin}`}}).then(r=>r.json()) as any;
  assert.equal(usage.attempts,2);assert.equal(usage.cap,2);
 }finally{await fixture.close();}
});

test('binary edits are rejected and an external executable-bit change survives content publication',async()=>{
 const bad=await api('/projects/sample/changes',{id:'binary',title:'Binary',intent:'Unsupported',files:[{path:'x.bin',content:'\u0000binary'}]},agent);assert.equal(bad.status,422);
 const base=project.head;
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const clone=server.dir+'/checkout';
 const p=await api('/projects/sample/changes',{id:'mode-safe',title:'Change text',intent:'Keep mode changes',base,files:[{path:'dependency.txt',content:'updated\n'}]},agent);assert.equal(p.status,201);
 await exec('git',['-C',clone,'update-index','--chmod=+x','dependency.txt']);await exec('git',['-C',clone,'-c','user.name=Tester','-c','user.email=test@example.invalid','commit','-m','Make executable']);await exec('git',['-C',clone,'push','origin','main']);
 await api('/projects/sample/changes/mode-safe/review',{decision:'approved'});const landed=await api('/projects/sample/publish',{id:'mode-batch',changes:['mode-safe']});assert.equal(landed.status,201,JSON.stringify(landed.body));
 const file=await api(`/projects/sample/file?ref=${landed.body.oid}&path=dependency.txt`);assert.equal(file.body.mode,'100755');assert.equal(file.body.content,'updated\n');
});

test('immutable source reads reuse the cache after authorization',async()=>{
 const p=(await api('/projects/sample')).body;
 await api(`/projects/sample/file?path=dependency.txt&ref=${p.head}`);
 const before=(await api('/usage')).body.attempts;
 const cached=await api(`/projects/sample/file?path=dependency.txt&ref=${p.head}`);assert.equal(cached.status,200);
 const after=(await api('/usage')).body.attempts;assert.equal(after,before);
 assert.equal((await api(`/projects/sample/file?path=dependency.txt&ref=${p.head}`,undefined,'wrong')).status,401);
});

test('an unpublished failed batch can be cancelled without rewriting Git',async()=>{
 const fixture=await startLocal({port:0,test:true,failPublicationBeforePushOnce:true});
 try{
  const call=async(path:string,b?:unknown)=>{const r=await fetch(fixture.url+'/api'+path,{method:b?'POST':'GET',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json() as any};};
  const made=await call('/projects',{id:'cancel',name:'Cancel',files:[]});await call('/projects/cancel/changes',{id:'one',title:'One',intent:'Cancel failed attempt',files:[{path:'b.txt',content:'b\n'}]});await call('/projects/cancel/changes/one/review',{decision:'approved'});
  assert.equal((await call('/projects/cancel/publish',{id:'interrupted',changes:['one']})).status,500);
  const abort=await call('/projects/cancel/publications/interrupted/abort',{expectedHead:made.data.head,note:'Push was never accepted'});assert.equal(abort.status,200,JSON.stringify(abort.data));assert.equal(abort.data.state,'aborted');
  const next=await call('/projects/cancel/publish',{id:'replacement',changes:['one']});assert.equal(next.status,201,JSON.stringify(next.data));
 }finally{await fixture.close();}
});

test('standard Git can clone through the authenticated read-only gateway',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const url=server.url+'/api/projects/sample/git';
 assert.equal((await fetch(url+'/info/refs?service=git-upload-pack')).status,401);
 const clone=server.dir+'/authenticated-checkout';
 await exec('git',['clone',url,clone],{env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:`Authorization: Bearer ${agent}`}});
 const {stdout}=await exec('git',['-C',clone,'show','HEAD:dependency.txt']);assert.equal(stdout,'updated\n');
 const push=await fetch(url+'/info/refs?service=git-receive-pack',{headers:{authorization:`Bearer ${admin}`}});assert.equal(push.status,403);
});

test('the complete HTTP workflow makes progress with a single database connection',async()=>{
 const fixture=await startLocal({port:0,test:true,poolSize:1});
 try{
  const call=async(path:string,b?:unknown)=>{const r=await fetch(fixture.url+'/api'+path,{method:b?'POST':'GET',headers:{authorization:`Bearer ${admin}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined,signal:AbortSignal.timeout(4000)});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
  await call('/projects',{id:'small-pool',name:'Single connection',files:[{path:'a.txt',content:'a\n'}]});
  await Promise.all(['one','two'].map(id=>call('/projects/small-pool/changes',{id,title:id,intent:'Progress under origin connection limits',files:[{path:id+'.txt',content:id+'\n'}]})));
  for(const id of ['one','two'])await call('/projects/small-pool/changes/'+id+'/review',{decision:'approved'});
  const batch=await call('/projects/small-pool/publish',{id:'batch',changes:['one','two']});assert.equal(batch.state,'published');
  await call('/projects/small-pool/changes',{id:'revise-me',title:'Revise',intent:'Keep context',context:{task:'small-pool'},files:[{path:'a.txt',content:'v1\n'}]});
  const revised=await call('/projects/small-pool/changes/revise-me/revise',{id:'revised',note:'Choose version two',files:[{path:'a.txt',content:'v2\n'}]});assert.equal(revised.context.task,'small-pool');assert.equal(revised.status,'proposed');
 }finally{await fixture.close();}
});

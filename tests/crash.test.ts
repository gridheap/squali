import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';

const message=(child:ChildProcess,phase:string)=>new Promise<any>((resolve,reject)=>{
 const timeout=setTimeout(()=>{cleanup();reject(new Error('Timed out waiting for '+phase));},10000);
 const receive=(m:any)=>{if(m.phase===phase){cleanup();resolve(m);}};
 const exited=(code:unknown,signal:unknown)=>{cleanup();reject(new Error(`Child exited before ${phase}: ${code} ${signal}`));};
 const cleanup=()=>{clearTimeout(timeout);child.off('message',receive);child.off('exit',exited);};child.on('message',receive);child.on('exit',exited);
});
async function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGKILL');await exited;}

test('a real process kill after Git accepted a batch recovers through the public HTTP API',async()=>{
 await mkdir('work',{recursive:true});const dir=await mkdtemp(resolve('work/crash-'));let child:ChildProcess|undefined;const logs:string[]=[];
 const start=async(pause:boolean)=>{child=fork(resolve('tests/fixtures/crash-server.ts'),[dir,pause?'pause':'resume'],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});child.stdout?.on('data',c=>logs.push(String(c)));child.stderr?.on('data',c=>logs.push(String(c)));return (await message(child,'ready')).url as string;};
 let url=await start(true);
 const call=async(path:string,body?:unknown)=>{const r=await fetch(url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});return {status:r.status,value:await r.json() as any};};
 try{
  assert.equal((await call('/projects',{id:'crash',name:'Real termination',files:[{path:'base.txt',content:'keep\n'}]})).status,201);
  assert.equal((await call('/projects/crash/changes',{id:'one',title:'One',intent:'Survive worker termination',files:[{path:'result.txt',content:'accepted once\n'}]})).status,201);
  assert.equal((await call('/projects/crash/changes/one/review',{decision:'approved'})).status,200);
  const pushed=message(child!,'pushed');const pending=call('/projects/crash/publish',{id:'once',changes:['one']}).catch(()=>null);await pushed;await stop(child);await pending;
  url=await start(false);
  const journal=(await call('/projects/crash/publications')).value.publications;assert.equal(journal[0].state,'preparing');
  const recovered=await call('/projects/crash/publish',{id:'once',changes:['one']});assert.equal(recovered.status,201,JSON.stringify(recovered.value));assert.equal(recovered.value.state,'published');
  assert.equal((await call('/projects/crash/file?path=result.txt')).value.content,'accepted once\n');
  assert.equal((await call('/projects/crash/publish',{id:'once',changes:['one']})).value.oid,recovered.value.oid);
  const events=(await call('/projects/crash/events')).value.events.filter((e:any)=>e.kind==='batch.published');assert.equal(events.length,1);
  await writeFile(join(dir,'report.json'),JSON.stringify({command:'pnpm test:crash',fault:'SIGKILL after native Git accepted push, before HTTP acknowledgement and SQL finalization',restarted:true,publication:recovered.value,publicationEvents:events.length},null,2));
 }finally{await stop(child);await writeFile(join(dir,'transcript.txt'),logs.join(''));}
});

test('a process killed before Git acceptance can be resumed by another reviewer with the same commit',async()=>{
 await mkdir('work',{recursive:true});const dir=await mkdtemp(resolve('work/crash-before-'));let child:ChildProcess|undefined;const logs:string[]=[];
 const start=async(mode:string)=>{child=fork(resolve('tests/fixtures/crash-server.ts'),[dir,mode],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});child.stdout?.on('data',c=>logs.push(String(c)));child.stderr?.on('data',c=>logs.push(String(c)));return (await message(child,'ready')).url as string;};
 let url=await start('pause-before');
 const call=async(path:string,body?:unknown)=>{const r=await fetch(url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});return {status:r.status,value:await r.json() as any};};
 try{
  assert.equal((await call('/projects',{id:'before',name:'Before acceptance',files:[{path:'base.txt',content:'keep\n'}]})).status,201);
  await call('/projects/before/changes',{id:'one',title:'One',intent:'Resume exact publication',files:[{path:'result.txt',content:'retained\n'}]});await call('/projects/before/changes/one/review',{decision:'approved'});
  const paused=message(child!,'before-push');const pending=call('/projects/before/publish',{id:'once',changes:['one']}).catch(()=>null);await paused;
  const saved=(await call('/projects/before/publications')).value.publications[0];assert.match(saved.oid,/^[a-f0-9]{40}$/);await stop(child);await pending;
  url=await start('resume-other');
  const recovered=await call('/projects/before/publish',{id:'once',changes:['one']});assert.equal(recovered.status,201,JSON.stringify(recovered.value));assert.equal(recovered.value.oid,saved.oid);
  assert.equal((await call('/projects/before/file?path=result.txt')).value.content,'retained\n');
  const events=(await call('/projects/before/events')).value.events.filter((e:any)=>e.kind==='batch.published');assert.equal(events.length,1);assert.equal(events[0].actor,'reviewer');
  await writeFile(join(dir,'report.json'),JSON.stringify({command:'pnpm test:crash',fault:'SIGKILL before native Git push',saved:saved.oid,recovered:recovered.value,publicationEvents:events.length,originalActor:events[0].actor},null,2));
 }finally{await stop(child);await writeFile(join(dir,'transcript.txt'),logs.join(''));}
});

for(const phase of ['before','after'])test(`cancellation survives SIGKILL ${phase} Git acceptance and retains one unchanged-tree audit commit`,async()=>{
 await mkdir('work',{recursive:true});const dir=await mkdtemp(resolve('work/cancel-crash-'));let child:ChildProcess|undefined;const logs:string[]=[];
 const start=async(mode:string)=>{child=fork(resolve('tests/fixtures/crash-server.ts'),[dir,mode],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});child.stdout?.on('data',c=>logs.push(String(c)));child.stderr?.on('data',c=>logs.push(String(c)));return (await message(child,'ready')).url as string;};
 let url=await start('pause-cancel-'+phase);
 const call=async(path:string,body?:unknown)=>{const r=await fetch(url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});return {status:r.status,value:await r.json() as any};};
 try{
  const made=await call('/projects',{id:'cancel',name:'Cancel recovery',files:[{path:'base.txt',content:'unchanged\n'}]});
  await call('/projects/cancel/changes',{id:'one',title:'One',intent:'Cancellation',files:[{path:'result.txt',content:'should not land\n'}]});await call('/projects/cancel/changes/one/review',{decision:'approved'});
  assert.equal((await call('/projects/cancel/publish',{id:'once',changes:['one']})).status,500);
  const paused=message(child!,phase==='before'?'before-push':'pushed');const input={expectedHead:made.value.head,note:'Cancelled once'};
  const pending=call('/projects/cancel/publications/once/abort',input).catch(()=>null);await paused;
  const saved=(await call('/projects/cancel/publications')).value.publications[0];assert.match(saved.cancellationHead,/^[a-f0-9]{40}$/);await stop(child);await pending;
  url=await start('resume-other');
  const recovered=await call('/projects/cancel/publications/once/abort',input);assert.equal(recovered.status,200,JSON.stringify(recovered.value));assert.equal(recovered.value.cancellationHead,saved.cancellationHead);assert.equal(recovered.value.state,'aborted');
  assert.equal((await call('/projects/cancel/file?path=base.txt')).value.content,'unchanged\n');assert.equal((await call('/projects/cancel/file?path=result.txt')).status,404);
  const events=(await call('/projects/cancel/events')).value.events.filter((e:any)=>e.kind==='batch.aborted');assert.equal(events.length,1);assert.equal(events[0].actor,'reviewer');
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const clone=join(dir,'native-checkout');
  await exec('git',['clone',url+'/api/projects/cancel/git',clone],{env:{...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Bearer local-admin-test-token'}});
  assert.equal((await exec('git',['-C',clone,'rev-parse','HEAD'])).stdout.trim(),saved.cancellationHead);
  assert.equal((await exec('git',['-C',clone,'rev-list','--count','HEAD'])).stdout.trim(),'2');
  assert.equal((await exec('git',['-C',clone,'diff','HEAD^','HEAD'])).stdout,'');await exec('git',['-C',clone,'fsck','--full']);
  await writeFile(join(dir,'report.json'),JSON.stringify({command:'pnpm test:crash',fault:`SIGKILL ${phase} cancellation Git acceptance`,original:made.value.head,recovered:recovered.value,auditEvents:events.length,nativeGit:{commits:2,treeDiff:'',fsck:'pass'}},null,2));
 }finally{await stop(child);await writeFile(join(dir,'transcript.txt'),logs.join(''));}
});

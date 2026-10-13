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

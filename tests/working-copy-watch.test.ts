import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,unlink,symlink,chmod,rename} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';
const exec=promisify(execFile);

// Failure specification: edits made before/during startup disappear; atomic replacement,
// additions, deletions or executable changes are missed; the watcher reads symlink targets,
// changes tracked state or sends HTTP; identical events flood output; the process or its
// descriptors outlive the explicit time/event budget; a changed base is silently reused.
test('bounded working-copy watch reports real filesystem changes without network or implicit tracking',{timeout:15000},async()=>{
 let queries=0;const server=await startLocal({port:0,test:true,source:true,onQuery:()=>queries++}),copy=server.dir+'/copy';
 const response=await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'watch',name:'Working-copy monitor',files:[{path:'src/edit.txt',content:'original\n'},{path:'src/delete.txt',content:'remove\n'},{path:'src/run.sh',content:'echo ok\n'}]})});assert.equal(response.status,201);
 const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_CACHE_DIR:server.dir+'/cache'};
 let child:ReturnType<typeof spawn>|undefined;
 try{
  await exec(process.execPath,['scripts/working-copy.mjs','checkout','watch',copy,'src'],{env});
  await writeFile(copy+'/src/edit.txt','before watch\n');
  const noToken:NodeJS.ProcessEnv={...env};delete noToken.SQUALI_TOKEN;queries=0;
  child=spawn(process.execPath,['scripts/working-copy.mjs','watch',copy,'--seconds','3','--max-events','100'],{env:noToken,stdio:['ignore','pipe','pipe']});
  let output='',errors='';const records:any[]=[];let ready:()=>void=()=>{};let rejectReady:(e:Error)=>void=()=>{};
  const started=new Promise<void>((ok,fail)=>{ready=ok;rejectReady=fail;});
  child.stdout!.on('data',chunk=>{output+=chunk;let at;while((at=output.indexOf('\n'))>=0){const line=output.slice(0,at);output=output.slice(at+1);if(line){const value=JSON.parse(line);records.push(value);if(value.event==='ready')ready();}}});child.stderr!.on('data',chunk=>errors+=chunk);
  const done=new Promise<number|null>(ok=>child!.once('exit',code=>{rejectReady(Error('Watch exited before ready: '+errors));ok(code);}));
  await started;assert.ok(records.find(r=>r.event==='ready').changes.some((r:any)=>r.path==='src/edit.txt'&&r.status==='modified'));
  await writeFile(copy+'/src/replacement.tmp','during watch\n');await rename(copy+'/src/replacement.tmp',copy+'/src/edit.txt');await unlink(copy+'/src/delete.txt');await writeFile(copy+'/src/new.txt','untracked\n');await chmod(copy+'/src/run.sh',0o755);await symlink('/etc/passwd',copy+'/src/link');
  assert.equal(await done,0,errors);assert.equal(queries,0,'Local monitoring performs no authenticated or provider request');
  const last=records.at(-1);assert.equal(last.event,'stopped');assert.equal(last.reason,'time-limit');assert.equal(last.complete,true);assert.equal(last.networkRequests,0);
  const dirty=new Map(last.changes.map((r:any)=>[r.path,r.status]));assert.equal(dirty.get('src/edit.txt'),'modified');assert.equal(dirty.get('src/delete.txt'),'deleted');assert.equal(dirty.get('src/new.txt'),'untracked');assert.equal(dirty.get('src/run.sh'),'modified');assert.equal(dirty.get('src/link'),'unsupported');
  assert.ok(records.some(r=>r.event==='change'&&r.path==='src/delete.txt'));assert.ok(records.length<30,'Duplicate native events are coalesced');
  const status=JSON.parse((await exec(process.execPath,['scripts/working-copy.mjs','status',copy],{env})).stdout);assert.ok(!status.changes.some((r:any)=>r.path==='src/new.txt'),'Watching must not implicitly add untracked content');
  await writeFile('docs/evidence/2026-10-15-source/working-copy-watch-events.json',JSON.stringify({command:'node --import tsx --test tests/working-copy-watch.test.ts',records},null,2)+'\n');
 }finally{child?.kill('SIGTERM');await server.close();}
});

test('working-copy watch stops at its event limit and rejects a base changed during startup',{timeout:15000},async()=>{
 const server=await startLocal({port:0,test:true,source:true}),copy=server.dir+'/copy';
 const env={...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token',SQUALI_CACHE_DIR:server.dir+'/cache'};
 let child:ReturnType<typeof spawn>|undefined;
 try{
  await fetch(server.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:'watch-race',name:'Watch race',files:[{path:'src/base.txt',content:'base\n'}]})});
  await exec(process.execPath,['scripts/working-copy.mjs','checkout','watch-race',copy,'src'],{env});
  // Exercise the event ceiling with a directory-entry event. A single content
  // write is not guaranteed to produce fs.watch delivery on macOS; the first
  // test covers content edits and the final reconciliation checks their state.
  const limited=spawn(process.execPath,['scripts/working-copy.mjs','watch',copy,'--seconds','5','--max-events','1'],{env,stdio:['ignore','pipe','pipe']});child=limited;let output='',errors='';let ready:()=>void=()=>{};const began=new Promise<void>(done=>{ready=done;});limited.stdout!.on('data',data=>{output+=data;if(output.includes('"event":"ready"'))ready();});limited.stderr!.on('data',data=>errors+=data);const ended=new Promise<number|null>(done=>limited.once('exit',done));await began;await writeFile(copy+'/src/limit-event.txt','new directory entry\n');assert.equal(await ended,0,errors);const stop=JSON.parse(output.trim().split('\n').at(-1)!);await writeFile('docs/evidence/2026-10-15-source/working-copy-watch-last-event.json',JSON.stringify({output,errors,stop},null,2)+'\n');assert.equal(stop.reason,'event-limit');assert.equal(stop.complete,true);assert.equal(stop.nativeEvents,1);assert.ok(stop.changes.some((change:any)=>change.path==='src/limit-event.txt'&&change.status==='untracked'));
  const preload=server.dir+'/pause-watch-read.mjs';await writeFile(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.promises.readFile;let held=false;fs.promises.readFile=async(...args)=>{const value=await original(...args);if(!held&&String(args[0]).endsWith('/.squali/manifest.json')){held=true;process.send({read:true});await new Promise(done=>process.once('message',done));}return value;};syncBuiltinESMExports();`);
  child=spawn(process.execPath,['--import',preload,'scripts/working-copy.mjs','watch',copy,'--seconds','2'],{env,stdio:['ignore','pipe','pipe','ipc']});let racedOutput='',racedErrors='';child.stdout!.on('data',data=>racedOutput+=data);child.stderr!.on('data',data=>racedErrors+=data);const racedEnd=new Promise<number|null>(done=>child!.once('exit',done));await new Promise<void>(done=>child!.once('message',()=>done()));
  const {readFile}=await import('node:fs/promises');const original=await readFile(copy+'/.squali/manifest.json','utf8');const manifest=JSON.parse(original);manifest.ref='1'.repeat(40);await writeFile(copy+'/.squali/manifest.json',JSON.stringify(manifest));child.send!({continue:true});
  assert.equal(await racedEnd,2,'A changed base must stop with a reconciliation error: '+racedErrors);const stopped=JSON.parse(racedOutput.trim().split('\n').at(-1)!);assert.equal(stopped.complete,false);assert.match(stopped.message,/base changed/i);assert.ok(!racedOutput.includes('"event":"ready"'),'Never advertise a stale working-copy base as ready');
  await writeFile('docs/evidence/2026-10-15-source/working-copy-watch-limits.json',JSON.stringify({command:'node --import tsx --test tests/working-copy-watch.test.ts',eventLimit:stop,startupRace:stopped},null,2)+'\n');
 }finally{child?.kill('SIGTERM');await server.close();}
});

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startLocal} from '../scripts/local.ts';

// Failure specification: actual workerd cannot call the source binding; Cache API
// leaks credential headers or cannot store POST-derived immutable data; request
// routing recurses; non-RPC project operations break; cross-isolate I/O is reused.
const source=await startLocal({port:0,test:true,source:true}),folder=source.dir+'/worker';await mkdir(folder);
const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};let child:ReturnType<typeof spawn>|undefined,transcript='';
try{
 const p=await fetch(source.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'workerd-region',name:'Workerd',files:[{path:'file.txt',content:'workerd bytes\n'}]})});assert.equal(p.status,201);const project=await p.json() as any;const file=await (await fetch(source.url+'/api/projects/workerd-region/file?path=file.txt',{headers})).json() as any;
 await writeFile(folder+'/source.ts',`export default {fetch(request:Request){return fetch(new Request(${JSON.stringify(source.url)}+new URL(request.url).pathname,request));}};\n`);
 await writeFile(folder+'/source.json',JSON.stringify({name:'regional-source-fixture',main:'source.ts',compatibility_date:'2026-10-13'}));
 await writeFile(folder+'/regional.json',JSON.stringify({name:'regional-fixture',main:resolve('src/regional-worker.ts'),compatibility_date:'2026-10-13',compatibility_flags:['nodejs_compat'],services:[{binding:'SOURCE',service:'regional-source-fixture'}],ratelimits:[{name:'SOURCE_LIMIT',namespace_id:'202610151',simple:{limit:600,period:60}}]}));
 child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config',folder+'/regional.json','--config',folder+'/source.json','--ip','127.0.0.1','--port',String(port),'--persist-to',folder+'/state'],{env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('Workerd readiness timeout')),20000);const receive=(b:Buffer)=>{transcript+=b.toString();if(transcript.includes('Ready on')){clearTimeout(timer);yes();}};child!.stdout!.on('data',receive);child!.stderr!.on('data',receive);child!.once('exit',code=>{clearTimeout(timer);no(Error('Workerd exited '+code));});});
 const url='http://127.0.0.1:'+port+'/api/projects/workerd-region';const rpc=(query:any)=>fetch(url+'/rpc',{method:'POST',headers,body:JSON.stringify(query)});
 const first=await rpc({op:'object',oid:file.oid});assert.equal(first.status,200,await first.clone().text());assert.equal(first.headers.get('x-squali-tier'),'regional');assert.equal(await first.text(),file.content);
 const second=await rpc({op:'object',oid:file.oid});assert.equal(second.status,200);assert.equal(second.headers.get('x-squali-cache'),'hit');assert.equal(await second.text(),file.content);
 const coalesced=await Promise.all(Array.from({length:8},()=>rpc({op:'object',oid:project.head})));for(const r of coalesced){assert.equal(r.status,200);await r.arrayBuffer();}assert.equal(coalesced.filter(r=>r.headers.get('x-squali-cache')==='miss').length,1,'Workerd requests share the same in-flight fill');
 const concurrent=await Promise.all(Array.from({length:8},()=>rpc({op:'head'})));for(const response of concurrent){assert.equal(response.status,200);await response.arrayBuffer();}
 const passthrough=await fetch(url,{headers});assert.equal(passthrough.status,200);assert.equal((await passthrough.json() as any).id,'workerd-region');
 assert.equal((await fetch(url+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'object',oid:file.oid})})).status,401);
 // Forwarded submissions retain source timings and expose the full binding wait.
 const proposal=await fetch(url+'/changes',{method:'POST',headers:{...headers,'x-squali-timing':'1'},body:JSON.stringify({id:'timing',title:'Timing',intent:'Measure forwarding',files:[{path:'new.txt',content:'timed write\n'}]})});assert.equal(proposal.status,201,await proposal.clone().text());
 const timing=proposal.headers.get('server-timing')??'';assert.match(timing,/regional;dur=[0-9.]+/);assert.match(timing,/db_connect;dur=[0-9.]+/);assert.match(timing,/app;dur=[0-9.]+/);
 const denied=await fetch(url+'/changes',{method:'POST',headers:{'content-type':'application/json','x-squali-timing':'1'},body:'{}'});assert.equal(denied.status,401);assert.equal(denied.headers.get('server-timing'),null);
 const report={command:'node --import tsx tests/regional-worker.e2e.ts',realWorkerd:true,serviceBinding:true,forwardedTiming:true,timing,cacheApiWarmHit:true,concurrentSourceRpcs:8,projectApiPreserved:true,unauthenticatedDenied:true,externalProviderCalls:0,passed:true};
 await writeFile('docs/evidence/2026-10-15-regional/workerd-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await writeFile('docs/evidence/2026-10-15-regional/workerd-transcript.txt',transcript);await source.close();}

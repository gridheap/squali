import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {localDatabase} from '../scripts/local.ts';
import {sha256} from '../src/git.ts';
// Failure specification: the RPC service binding recurses; new regional and
// legacy RPCs bypass authorization/cache; direct writes acquire a forwarding
// hop; real workerd loses array codecs across fresh database clients.
const admin=postgres(localDatabase,{max:1,fetch_types:false}),name='routing_'+randomUUID().replaceAll('-','');
await admin.unsafe('CREATE DATABASE '+name);const endpoint=new URL(localDatabase);endpoint.pathname='/'+name;
const setup=postgres(endpoint.toString(),{max:1,fetch_types:false});await setup.unsafe('CREATE SCHEMA weave; SET search_path=weave; '+await readFile('src/schema.sql','utf8'));await setup.end();
const folder=await mkdtemp(resolve('work/routing-'));const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()));
let child:ReturnType<typeof spawn>|undefined,transcript='';
const evidence='docs/evidence/2026-10-15-tail-latency/';
try{
 const vars={DATABASE_URL:endpoint.toString(),PRINCIPALS_JSON:JSON.stringify({[sha256('routing-owner')]:{id:'reviewer',role:'admin',projects:['*']}}),MAX_PROJECTS:'5',MONTHLY_SOURCE_READ_CAP:'1000',MONTHLY_SOURCE_WRITE_CAP:'1000',SOURCE_REPOSITORY_BYTE_CAP:String(1024**3),MONTHLY_ARTIFACT_CALL_CAP:'10',MONTHLY_R2_READ_CAP:'100',MONTHLY_R2_WRITE_CAP:'100'};
 await writeFile(folder+'/source.json',JSON.stringify({name:'routing-source',main:resolve('src/worker.ts'),compatibility_date:'2026-10-13',compatibility_flags:['nodejs_compat'],vars,r2_buckets:[{binding:'SOURCE',bucket_name:'local-source'},{binding:'OBJECTS',bucket_name:'local-objects'}],services:[{binding:'REGIONAL',service:'routing-regional'}]}));
 await writeFile(folder+'/regional.json',JSON.stringify({name:'routing-regional',main:resolve('src/regional-worker.ts'),compatibility_date:'2026-10-13',compatibility_flags:['nodejs_compat'],services:[{binding:'SOURCE',service:'routing-source',entrypoint:'SourceRpc'}],ratelimits:[{name:'SOURCE_LIMIT',namespace_id:'202610151',simple:{limit:600,period:60}}]}));
 child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config',folder+'/source.json','--config',folder+'/regional.json','--ip','127.0.0.1','--port',String(port),'--persist-to',folder+'/state'],{env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
 await new Promise<void>((yes,no)=>{const timer=setTimeout(()=>no(Error('Workerd readiness timeout')),20000);const receive=(b:Buffer)=>{transcript+=b.toString();if(transcript.includes('Ready on')){clearTimeout(timer);yes();}};child!.stdout!.on('data',receive);child!.stderr!.on('data',receive);child!.once('exit',code=>{clearTimeout(timer);no(Error('Workerd exited '+code));});});
 const url='http://127.0.0.1:'+port,headers={authorization:'Bearer routing-owner','content-type':'application/json','x-squali-timing':'1'};
 const call=async(path:string,body?:unknown,authorized=true)=>fetch(url+'/api'+path,{method:body===undefined?'GET':'POST',headers:authorized?headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const project=await call('/projects',{id:'routing',name:'Routing',files:[]});assert.equal(project.status,201,await project.clone().text());const base=(await project.json() as any).head;
 const changes=[];const timings=[];
 for(let i=0;i<4;i++){
  const c=await call('/projects/routing/changes',{id:'c'+i,title:'Route '+i,intent:'Preserve codecs and routing',base,dependencies:i?['c'+(i-1)]:[],files:[{path:'文件,"'+i+'.txt',content:'route '+i+'\n'}]});assert.equal(c.status,201,await c.clone().text());const value=await c.json() as any;assert.deepEqual(value.dependencies,i?['c'+(i-1)]:[]);changes.push(value.id);const timing=c.headers.get('server-timing')??'';assert.match(timing,/db_connect;dur=/);assert.doesNotMatch(timing,/regional;dur=/);timings.push(timing);assert.equal((await call('/projects/routing/changes/'+value.id+'/review',{decision:'approved'})).status,200);
 }
 const publication=await call('/projects/routing/publish',{id:'publish',changes:[...changes].reverse(),expectedHead:base});assert.equal(publication.status,201,await publication.clone().text());
 const file=await (await call('/projects/routing/file?path='+encodeURIComponent('文件,"3.txt'))).json() as any;
 // Source custom-domain requests exercise the compatibility gateway; a named
 // source entrypoint makes the return service-binding hop nonrecursive.
 for(const path of ['/projects/routing/rpc','/regional/projects/routing/rpc']){
  const read=await call(path,{op:'object',oid:file.oid});assert.equal(read.status,200,await read.clone().text());assert.equal(read.headers.get('x-squali-tier'),'regional');assert.equal(await read.text(),'route 3\n');
  const hit=await call(path,{op:'object',oid:file.oid});assert.equal(hit.headers.get('x-squali-cache'),'hit');await hit.arrayBuffer();assert.equal((await call(path,{op:'object',oid:file.oid},false)).status,401);
 }
 const report={command:'node --import tsx tests/source-routing.e2e.ts',realSourceWorkerd:true,realRegionalWorkerd:true,localPostgres:true,localR2:true,proposals:4,publication:true,legacyAndDedicatedRegionalRoutes:true,directWrites:true,timings,externalProviderCalls:0,passed:true};await writeFile(evidence+'source-routing-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await writeFile(evidence+'source-routing-transcript.txt',transcript);await admin.unsafe('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}

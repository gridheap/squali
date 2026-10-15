// Public seams: HTTP source writes and native Git export. Failure specification:
// excessive database round trips, failed/duplicate writes under concurrency,
// hidden retries, changed main before review, or incompatible published bytes.
// All storage and the deliberately delayed PostgreSQL TCP link remain local.
import assert from 'node:assert/strict';
import {createServer,createConnection,type Socket} from 'node:net';
import {Transform} from 'node:stream';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileBucket} from '../scripts/source-bucket.ts';

const output=process.env.WRITE_PATH_OUTPUT;assert.ok(output,'Set a fresh WRITE_PATH_OUTPUT directory');
const appDir=resolve(process.env.WRITE_PATH_APP_DIR??'.'),database=new URL(process.env.DATABASE_URL??'postgres://weave@127.0.0.1:55439/weave');
assert.ok(['127.0.0.1','localhost'].includes(database.hostname),'This test only uses a local PostgreSQL instance');
await mkdir(output,{recursive:false});
const sockets=new Set<Socket>(),timers=new Set<ReturnType<typeof setTimeout>>();
const proxy=createServer(client=>{
 const target=createConnection({host:database.hostname,port:Number(database.port)||5432});
 for(const socket of [client,target]){sockets.add(socket);socket.setNoDelay(true);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{client.destroy();target.destroy();});}
 const delayed=()=>new Transform({transform(chunk,_encoding,done){const timer=setTimeout(()=>{timers.delete(timer);done(null,chunk);},10);timers.add(timer);}});
 client.pipe(delayed()).pipe(target);target.pipe(delayed()).pipe(client);
});
await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
const proxied=new URL(database);proxied.hostname='127.0.0.1';proxied.port=String((proxy.address() as any).port);process.env.DATABASE_URL=proxied.toString();
const {startLocal}=await import(pathToFileURL(resolve(appDir,'scripts/local.ts')).href);
let queries=0,attempts=0;const operations={put:0,get:0,head:0};
const bucket=fileBucket(resolve('work','write-path-'+randomUUID()));
let server:any;const phases:any[]=[],report:any={command:'WRITE_PATH_OUTPUT='+output+(process.env.WRITE_PATH_APP_DIR?' WRITE_PATH_APP_DIR='+process.env.WRITE_PATH_APP_DIR:'')+' node --import tsx tests/write-path-capacity.e2e.ts',complete:false,externalProviderCalls:0,dataset:{baselineFiles:64,proposalCounts:[8,64,64],concurrency:[1,8,32],poolSize:8},databaseLink:{delayEachDirectionMs:10,synthetic:true},phases};
for(const file of ['src/changes.ts','src/source-store.ts'])report[file]=createHash('sha256').update(await readFile(resolve(appDir,file))).digest('hex');
const save=()=>writeFile(output+'/result.json',JSON.stringify(report,null,2)+'\n');await save();
try{
 server=await startLocal({port:0,test:true,source:true,poolSize:8,onQuery:()=>queries++,sourceBucket:{async put(k:any,b:any,o:any){operations.put++;return bucket.put(k,b,o);},async get(k:any){operations.get++;return bucket.get(k);},async head(k:any){operations.head++;return bucket.head(k);}}});
 const call=async(path:string,body?:unknown,agent=false)=>{
  assert.ok(++attempts<=256,'Finite HTTP attempt ceiling');
  const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+(agent?'local-agent-test-token':'local-admin-test-token'),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const value=await r.json() as any;assert.ok(r.ok,JSON.stringify({status:r.status,value}));return value;
 };
 const project=await call('/projects',{id:'write-capacity',name:'Write capacity',files:Array.from({length:64},(_,i)=>({path:'src/'+i,content:'baseline '+i+'\n'}))});
 const ids:string[]=[],beforeUsage=await call('/usage');
 for(const [concurrency,count] of [[1,8],[8,64],[32,64]]){
  const storage={...operations},sql=queries,cpu=process.cpuUsage(),at=performance.now(),latencies:number[]=[],errors:any[]=[];let next=0;
  await Promise.all(Array.from({length:concurrency},async()=>{while(next<count){const i=next++,id='c'+concurrency+'-'+i,start=performance.now();try{await call('/projects/write-capacity/changes',{id,title:id,intent:'Bounded local comparison',base:project.head,files:[{path:'changes/'+id,content:'result '+id+'\n'}]},true);ids.push(id);}catch(error){errors.push({id,error:String(error)});}finally{latencies.push(performance.now()-start);}}}));
  const wallMs=performance.now()-at,used=process.cpuUsage(cpu),sorted=latencies.toSorted((a,b)=>a-b);
  const phase={concurrency,count,errors,wallMs,requestsPerSecond:(count-errors.length)*1000/wallMs,p50Ms:sorted[Math.ceil(count*.5)-1],p95Ms:sorted[Math.ceil(count*.95)-1],sqlStatements:queries-sql,sqlPerProposal:(queries-sql)/count,nodeCpuMs:(used.user+used.system)/1000,nodeMaxRssKiB:process.resourceUsage().maxRSS,storage:Object.fromEntries(Object.entries(operations).map(([k,v])=>[k,v-storage[k as keyof typeof storage]]))};
  phases.push(phase);await save();console.log(JSON.stringify(phase));assert.equal(errors.length,0);assert.equal(phase.storage.put,count);assert.equal(phase.storage.get,0);
 }
 const afterUsage=await call('/usage');assert.equal(afterUsage.attempts,beforeUsage.attempts,'Source proposals need no Artifacts operations');
 assert.equal((await call('/projects/write-capacity')).head,project.head);
 const publish=ids.slice(0,8);for(const id of publish)await call('/projects/write-capacity/changes/'+id+'/review',{decision:'approved',note:'Local benchmark acceptance'});
 const published=await call('/projects/write-capacity/publish',{id:'verified-batch',changes:publish,expectedHead:project.head});
 const exec=promisify(execFile),clone=server.dir+'/native-export';
 await exec('git',['-c','http.extraHeader=Authorization: Bearer local-admin-test-token','clone',server.url+'/api/projects/write-capacity/git',clone]);
 assert.equal((await exec('git',['-C',clone,'rev-parse','HEAD'])).stdout.trim(),published.oid);
 await exec('git',['-C',clone,'fsck','--full']);for(const id of publish)assert.equal(await readFile(clone+'/changes/'+id,'utf8'),'result '+id+'\n');
 report.complete=true;report.httpAttempts=attempts;report.sourcePhaseArtifactsOperations=0;report.nativeGit={publishedChanges:8,exactHead:true,exactFiles:true,fsck:true};
 report.limitations=['Local Node HTTP source, PostgreSQL and filesystem R2 adapter; no production throughput or Cloudflare CPU claim.','TCP proxy adds 10 ms per direction per chunk; this approximates network sensitivity, not a WAN measurement.','Node CPU includes HTTP load generator and latency proxy; it excludes PostgreSQL CPU.','Fresh isolated fixture per version; one controlled comparison, not a statistical confidence interval.'];await save();
}catch(error){report.error=String(error);await save();throw error;}
finally{if(server)await server.close();for(const socket of sockets)socket.destroy();for(const timer of timers)clearTimeout(timer);await new Promise<void>(r=>proxy.close(()=>r()));}

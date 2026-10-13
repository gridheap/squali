import {startLocal} from './local.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {cpus,totalmem,platform,arch} from 'node:os';
import {performance} from 'node:perf_hooks';
const exec=promisify(execFile), count=32, concurrency=8;
const output=resolve(process.env.SQUALI_COMPARE_DIR??'work/native-comparison');await mkdir(output,{recursive:true});
const server=await startLocal({port:0,test:true,poolSize:5});
const git=async(cwd:string,args:string[])=>exec('git',['-C',cwd,...args],{maxBuffer:2*1024*1024});
const identity=['-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid'];
const files=Array.from({length:64},(_,i)=>({path:`seed/file-${i}.txt`,content:('immutable baseline '+i+'\n').repeat(300)}));
const change=(i:number)=>({path:`agents/${i}.ts`,content:`export const agent${i} = ${i};\n`});
const stats=(values:number[])=>{const sorted=values.toSorted((a,b)=>a-b);const p=(n:number)=>+sorted[Math.min(sorted.length-1,Math.ceil(n*sorted.length)-1)].toFixed(2);return {p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99)};};
async function call(path:string,body?:unknown,agent=false){const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(agent?'local-agent-test-token':'local-admin-test-token'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const data=await r.json() as any;if(!r.ok)throw new Error(JSON.stringify(data));return data;}
async function pool(work:(i:number,worker:number)=>Promise<void>){let next=0;await Promise.all(Array.from({length:concurrency},async(_,worker)=>{while(next<count)await work(next++,worker);}));}
async function verify(remote:string,name:string){const path=join(server.dir,'verify-'+name);await exec('git',['clone',remote,path]);await git(path,['fsck','--full']);for(const f of [...files,...Array.from({length:count},(_,i)=>change(i))]){const actual=(await git(path,['show','HEAD:'+f.path])).stdout;if(actual!==f.content)throw new Error(name+' content mismatch '+f.path);}const paths=(await git(path,['ls-tree','-r','--name-only','HEAD'])).stdout.trim().split('\n');if(paths.length!==files.length+count)throw new Error(name+' unexpected file count');const tree=(await git(path,['rev-parse','HEAD^{tree}'])).stdout.trim();return {tree,files:paths.length,fsck:'pass'};}
const report:any={command:'pnpm exec tsx scripts/compare-git.ts',timestamp:new Date().toISOString(),scope:'Local Git HTTP and real PostgreSQL, five database connections; no cloud calls',environment:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),node:process.version,git:(await exec('git',['--version'])).stdout.trim()},dataset:{baselineFiles:files.length,baselineBytes:files.reduce((n,f)=>n+Buffer.byteLength(f.content),0),changes:count,concurrency},limitations:['32 observations per path; p99 is effectively the maximum, not a tail-latency estimate','Native Git omits owner authorization, review records, SQL journaling and reservation accounting','Warm native clients reuse full clones; clone preparation is reported separately','Native squash uses Git merge; Squali has its own bounded text merge and proposal metadata','One machine and independent edits; no distributed scaling, cost-per-workflow or conflict-heavy claim']};
try{
 const squali=await call('/projects',{id:'squali',name:'Squali comparison',files});
 const latencies:number[]=[];const before=(await call('/usage')).attempts;let start=performance.now();
 await pool(async i=>{const at=performance.now();await call('/projects/squali/changes',{id:'agent-'+i,title:'Agent '+i,intent:'Independent bounded performance fixture',context:{fixture:true},files:[change(i)]},true);latencies.push(performance.now()-at);});
 const wall=performance.now()-start;
 start=performance.now();for(let i=0;i<count;i++)await call(`/projects/squali/changes/agent-${i}/review`,{decision:'approved',note:'Benchmark fixture'});const reviewMs=performance.now()-start;
 start=performance.now();const publication=await call('/projects/squali/publish',{id:'batch',changes:Array.from({length:count},(_,i)=>'agent-'+i)});const publishMs=performance.now()-start;
 report.squali={failures:0,proposalWallMs:+wall.toFixed(2),proposalsPerSecond:+(count/wall*1000).toFixed(2),...stats(latencies),reviewMs:+reviewMs.toFixed(2),publicationMs:+publishMs.toFixed(2),publicationMetrics:publication.metrics,localAdapterReservations:(await call('/usage')).attempts-before,verification:await verify(squali.remote,'squali')};
 const native=await call('/projects',{id:'native',name:'Native Git comparison',files});const clients=Array.from({length:concurrency},(_,i)=>join(server.dir,'client-'+i));
 start=performance.now();await Promise.all(clients.map(path=>exec('git',['clone',native.remote,path])));const cloneMs=performance.now()-start;
 const nativeLatencies:number[]=[];start=performance.now();
 await pool(async(i,worker)=>{const at=performance.now(),path=clients[worker],f=change(i);await git(path,['checkout','--detach',native.head]);await mkdir(join(path,'agents'),{recursive:true});await writeFile(join(path,f.path),f.content);await git(path,['add',f.path]);await git(path,[...identity,'commit','-m',`Agent ${i}\n\nIntent: Independent bounded performance fixture`]);await git(path,['push','origin',`HEAD:refs/heads/weave/agent-${i}`]);nativeLatencies.push(performance.now()-at);});
 const nativeWall=performance.now()-start;
 const reviewer=clients[0];start=performance.now();await git(reviewer,['fetch','origin']);await git(reviewer,['checkout','--detach',native.head]);await git(reviewer,[...identity,'merge','--squash',...Array.from({length:count},(_,i)=>'origin/weave/agent-'+i)]);await git(reviewer,[...identity,'commit','-m','Publish all approved benchmark changes']);await git(reviewer,['push','origin','HEAD:main']);const nativePublish=performance.now()-start;
 report.nativeGit={failures:0,clonePreparationMs:+cloneMs.toFixed(2),proposalWallMs:+nativeWall.toFixed(2),proposalsPerSecond:+(count/nativeWall*1000).toFixed(2),...stats(nativeLatencies),publicationMs:+nativePublish.toFixed(2),verification:await verify(native.remote,'native')};
 for(const p of [squali,native]){const refs=(await exec('git',['ls-remote',p.remote,'refs/heads/weave/*'])).stdout.trim().split('\n');if(refs.length!==count)throw new Error('Missing proposal refs');}
 if(report.squali.verification.tree!==report.nativeGit.verification.tree)throw new Error('Final Git trees differ');
 report.identicalFinalTree=true;report.proposalRefsPerPath=count;
 await writeFile(join(output,'comparison.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({command:report.command,error:String(error)},null,2));throw error;}finally{await server.close();}

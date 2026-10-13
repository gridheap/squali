import {startLocal} from './local.ts';
import {cpus,totalmem,platform,arch} from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const count=Number(process.env.BENCH_CHANGES??32),concurrency=Number(process.env.BENCH_CONCURRENCY??8);
if(!Number.isSafeInteger(count)||count<1||count>256||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>32)throw new Error('Bounded local benchmark: 1–256 changes, concurrency 1–32.');
const server=await startLocal({port:0,test:true});const latencies:number[]=[];let errors=0;
async function call(path:string,body?:unknown,agent=false){const start=performance.now();const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(agent?'local-agent-test-token':'local-admin-test-token'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await r.json() as any;if(!r.ok){errors++;throw new Error(JSON.stringify(value));}return {value,ms:performance.now()-start};}
try{
 const files=Array.from({length:64},(_,i)=>({path:`seed/file-${i}.txt`,content:('immutable baseline '+i+'\n').repeat(300)}));
 await call('/projects',{id:'bench',name:'Bounded local benchmark',files});
 const begin=performance.now();let next=0;
 await Promise.all(Array.from({length:concurrency},async()=>{while(next<count){const i=next++;const {ms}=await call('/projects/bench/changes',{id:'agent-'+i,title:'Agent '+i,intent:'Independent bounded performance fixture',context:{fixture:true},files:[{path:`agents/${i}.ts`,content:`export const agent${i} = ${i};\n`}]},true);latencies.push(ms);}}));
 const writeMs=performance.now()-begin;
 for(let i=0;i<count;i++)await call(`/projects/bench/changes/agent-${i}/review`,{decision:'approved',note:'Benchmark fixture'});
 const batches=[];for(let i=0;i<count;i+=64)batches.push(await call('/projects/bench/publish',{id:'batch-'+i,changes:Array.from({length:Math.min(64,count-i)},(_,j)=>'agent-'+(i+j))}));
 const sorted=latencies.toSorted((a,b)=>a-b);const percentile=(n:number)=>Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*n)-1)]*100)/100;
 const report={command:`BENCH_CHANGES=${count} BENCH_CONCURRENCY=${concurrency} pnpm benchmark`,scope:'LOCAL ONLY: real PostgreSQL and Git HTTP backend; excludes Cloudflare and network latency',timestamp:new Date().toISOString(),environment:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),node:process.version},dataset:{baselineFiles:64,baselineBytes:files.reduce((n,f)=>n+Buffer.byteLength(f.content),0),changes:count,concurrency},results:{failures:errors,writeWallMs:Math.round(writeMs),changesPerSecond:Math.round(count/writeMs*100000)/100,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),publicationMs:batches.map(x=>Math.round(x.ms)),publicationMetrics:batches.map(x=>x.value.metrics),usage:(await call('/usage')).value},limitations:['No comparison against another forge under identical conditions','One machine; not a distributed or 100,000-agent test','Local adapter invokes native Git processes; production uses Artifacts RPC','Source changes are independent and small; conflict-heavy results will differ']};
 const output=process.env.WEAVE_BENCH_DIR??'work/benchmarks';await mkdir(output,{recursive:true});await writeFile(output+'/local.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await server.close();}

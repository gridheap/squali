import {AsyncLocalStorage} from 'node:async_hooks';

type Stage='auth'|'scope'|'project'|'lookup'|'base'|'journal'|'build'|'delta'|'persist'|'admission'|'r2_put'|'blob_ready'|'seal'|'seal_read'|'seal_write'|'graph'|'paths'|'finalize'|'app';
type Trace={authorized:boolean;durations:Map<Stage,number>};
const traces=new AsyncLocalStorage<Trace>();
const noop=()=>{};
export function startStage(name:Stage){
 const trace=traces.getStore();if(!trace)return noop;
 const start=performance.now();
 return ()=>trace.durations.set(name,(trace.durations.get(name)??0)+performance.now()-start);
}
export async function timed<T>(name:Stage,run:()=>PromiseLike<T>):Promise<T>{
 const end=startStage(name);try{return await run();}finally{end();}
}
export function authorizeTiming(){const trace=traces.getStore();if(trace)trace.authorized=true;}
/** Opt-in, fixed-name, bounded response metadata. No logs, extra storage calls,
 * input values or cross-request state. Parent spans include their children.
 * Workers' clock advances with I/O; these are wall timings, not CPU samples. */
export function timeRequest(request:Request,run:()=>Promise<Response>):Promise<Response>{
 if(request.headers.get('x-squali-timing')!=='1'||request.method!=='POST'||!/^\/api\/projects\/[^/]+\/changes$/.test(new URL(request.url).pathname))return run();
 const trace:Trace={authorized:false,durations:new Map()};
 return traces.run(trace,async()=>{
  const response=await timed('app',run);
  if(trace.authorized){response.headers.set('server-timing',[...trace.durations].map(([name,ms])=>`${name};dur=${ms.toFixed(2)}`).join(', '));response.headers.set('cache-control','private, no-store');}
  return response;
 });
}

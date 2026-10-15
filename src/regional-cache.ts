import {createHash} from 'node:crypto';

type Query={op:'authorize'|'head'}|{op:'object';oid:string}|{op:'stat';oids:string[]};
type Entry={bytes:Uint8Array;headers:Record<string,string>};
type Stream={response:Response;stream:true};
interface RegionalOptions {
 upstream:{fetch(request:Request):Promise<Response>};
 cache:{match(request:Request):Promise<Response|undefined>;put(request:Request,response:Response):Promise<void>};
 admit:()=>Promise<boolean>;
 now?:()=>number;maxUpstream?:number;maxEntryBytes?:number;timeoutMs?:number;
}
class Fault extends Error {constructor(public status:number,message:string){super(message);}}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const oid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const kinds=['blob','tree','commit','tag'];
const boundedSet=<T>(map:Map<string,T>,key:string,value:T)=>{if(map.size>=1024&&!map.has(key))map.delete(map.keys().next().value!);map.set(key,value);};

/** One independently placed cache tier. Its sole upstream is a service binding. */
export function regionalRpc(options:RegionalOptions){
 const now=options.now??Date.now,cap=options.maxEntryBytes??1024*1024,timeout=options.timeoutMs??10000;
 const leases=new Map<string,number>(),authorizing=new Map<string,Promise<number>>(),failures=new Map<string,{until:number;error:Fault}>();
 const flights=new Map<string,Promise<Entry|Stream>>();let active=0,upstreamActive=0,circuitUntil=0;
 const response=(entry:Entry,state:string)=>new Response(entry.bytes as BodyInit,{headers:{...entry.headers,'cache-control':'private, no-store','x-content-type-options':'nosniff','x-squali-tier':'regional','x-squali-cache':state}});
 const fault=(status:number,message:string)=>Response.json({error:'regional_cache',message},{status,headers:{'cache-control':'private, no-store','x-squali-tier':'regional',...(status===429||status===503?{'retry-after':'5'}:{})}});
 const bounded=async<T>(promise:Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Fault(503,'Cache operation timed out; no bypass')),timeout);})]);}finally{clearTimeout(timer!);}};
 async function readSmall(r:Response,max:number):Promise<Uint8Array>{
  const reader=r.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await bounded(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>max)throw new Fault(503,'Response exceeds its bounded cache record');chunks.push(part.value);}return Buffer.concat(chunks,size);}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 }
 function verify(query:Query,entry:Entry){
  if(query.op==='object'){
   const kind=entry.headers['x-squali-type'];if(!kinds.includes(kind)||entry.headers['x-squali-oid']!==query.oid||createHash('sha1').update(`${kind} ${entry.bytes.length}\0`).update(entry.bytes).digest('hex')!==query.oid)throw new Fault(502,'Object identity mismatch');
  }else if(query.op==='stat'){
   let objects:any;try{objects=JSON.parse(Buffer.from(entry.bytes).toString()).objects;}catch{throw new Fault(502,'Invalid stat response');}
   if(!Array.isArray(objects)||objects.length!==query.oids.length||new Set(objects.map((v:any)=>v.oid)).size!==query.oids.length||objects.some((v:any)=>!query.oids.includes(v.oid)||!kinds.includes(v.type)||!Number.isSafeInteger(v.size)||v.size<0))throw new Fault(502,'Invalid stat response');
  }
 }
 async function send(project:string,authorization:string,query:Query){
  if(circuitUntil>now())throw new Fault(503,'Source circuit is open; no bypass or automatic retry');
  if(upstreamActive>=(options.maxUpstream??4))throw new Fault(503,'Regional source concurrency is full');
  upstreamActive++;const controller=new AbortController();let released=false,timer:ReturnType<typeof setTimeout>;
  const finish=()=>{if(!released){released=true;clearTimeout(timer);upstreamActive--;}};
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{circuitUntil=now()+5000;controller.abort();finish();reject(new Fault(503,'Source RPC timed out; no automatic retry'));},timeout);});void deadline.catch(()=>{});
  try{
   if(!await Promise.race([options.admit(),deadline]))throw new Fault(429,'Regional source admission limit reached');
   const request=new Request('https://squa.li/api/projects/'+project+'/rpc',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(query),signal:controller.signal,redirect:'manual'});
   const pending=options.upstream.fetch(request);void pending.then(r=>{if(released)void r.body?.cancel().catch(()=>{});},()=>{});
   const r=await Promise.race([pending,deadline]);
   if(!r.ok){void r.body?.cancel().catch(()=>{});if(r.status>=500)circuitUntil=now()+5000;throw new Fault([400,401,403,404,409,413,429].includes(r.status)?r.status:503,'Source rejected this RPC');}
   return {r,finish,deadline,abort:()=>controller.abort()};
  }catch(error){finish();if(error instanceof Fault)throw error;circuitUntil=now()+5000;throw new Fault(503,'Source RPC unavailable; no bypass or automatic retry');}
 }
 async function authorize(project:string,authorization:string){
  const key=sha(project+'\0'+authorization),lease=leases.get(key);if(lease&&lease>now())return lease;
  const denied=failures.get('auth:'+key);if(denied&&denied.until>now())throw denied.error;
  const running=authorizing.get(key);if(running)return running;
  const pending=(async()=>{const {r,finish,deadline}=await send(project,authorization,{op:'authorize'});try{const value=JSON.parse(Buffer.from(await Promise.race([readSmall(r,4096),deadline])).toString());if(value.project!==project||!Number.isFinite(value.expiresAt))throw new Fault(502,'Invalid authorization lease');const expires=Math.min(value.expiresAt,now()+30000);if(expires<=now())throw new Fault(401,'Authorization lease has expired');boundedSet(leases,key,expires);return expires;}finally{finish();}})();
  authorizing.set(key,pending);try{return await pending;}catch(error){const failure=error instanceof Fault?error:new Fault(503,'Authorization unavailable');boundedSet(failures,'auth:'+key,{until:now()+5000,error:failure});throw failure;}finally{authorizing.delete(key);}
 }
 async function load(project:string,authorization:string,query:Query,key:string,cacheKey:Request):Promise<Entry|Stream>{
  const {r,finish,deadline,abort}=await send(project,authorization,query);let streamed=false;
  try{
   const headers:Record<string,string>={'content-type':query.op==='object'?'application/octet-stream':'application/json'};
   if(query.op==='object'){
    const kind=r.headers.get('x-squali-type')??'',id=r.headers.get('x-squali-oid')??'';if(!kinds.includes(kind)||id!==query.oid)throw new Fault(502,'Object identity headers mismatch');headers['x-squali-type']=kind;headers['x-squali-oid']=id;
    const length=Number(r.headers.get('content-length'));if(!r.headers.has('content-length')||!Number.isSafeInteger(length)||length<0||length>32*1024*1024)throw new Fault(502,'Invalid object size');headers['content-length']=String(length);
    if(length>cap){
     const reader=r.body!.getReader(),hash=createHash('sha1').update(`${kind} ${length}\0`);let seen=0,ended=false;streamed=true;
     const end=()=>{if(!ended){ended=true;finish();flights.delete(key);}};
     void deadline.catch(()=>{abort();void reader.cancel().catch(()=>{});end();});
     const body=new ReadableStream<Uint8Array>({async pull(out){try{const part=await Promise.race([reader.read(),deadline]);if(part.done){if(seen!==length||hash.digest('hex')!==id)throw new Fault(502,'Streamed object identity mismatch');out.close();end();return;}seen+=part.value.length;if(seen>length)throw new Fault(502,'Streamed object exceeds declared size');hash.update(part.value);out.enqueue(part.value);}catch(error){abort();void reader.cancel().catch(()=>{});out.error(error);end();}},cancel(){abort();void reader.cancel().catch(()=>{});end();}});
     return {stream:true,response:new Response(body,{headers:{...headers,'cache-control':'private, no-store','x-squali-tier':'regional','x-squali-cache':'stream','x-content-type-options':'nosniff'}})};
    }
   }
   const bytes=await Promise.race([readSmall(r,query.op==='object'?cap:512*1024),deadline]);const entry={bytes,headers};verify(query,entry);
   if(query.op==='object'&&bytes.length!==Number(headers['content-length']))throw new Fault(502,'Truncated source object');
   try{await bounded(options.cache.put(cacheKey,new Response(bytes as BodyInit,{headers:{...headers,'cache-control':'public, max-age=86400, immutable','content-length':String(bytes.length)}})));}catch{throw new Fault(503,'Regional cache fill failed; no bypass');}
   return entry;
  }finally{if(!streamed){finish();void r.body?.cancel().catch(()=>{});}}
 }
 return async(request:Request):Promise<Response>=>{
  if(active>=16)return fault(503,'Regional request concurrency is full');active++;
  try{
   const url=new URL(request.url),match=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,62})\/rpc$/);
   if(request.method!=='POST'||!match||url.search)throw new Fault(404,'Use the source RPC endpoint');
   if(request.headers.has('origin')&&request.headers.get('origin')!==url.origin)throw new Fault(403,'Cross-origin RPC is forbidden');
   const authorization=request.headers.get('authorization')??'';if(!/^Bearer \S{1,8192}$/.test(authorization))throw new Fault(401,'Supply a workspace credential');
   let input:any;try{input=JSON.parse(Buffer.from(await readSmall(new Response(request.body),128*1024)).toString());}catch{throw new Fault(400,'Invalid bounded RPC request');}
   let query:Query;if(input?.op==='object'&&oid(input.oid))query={op:'object',oid:input.oid};else if(input?.op==='stat'&&Array.isArray(input.oids)&&input.oids.length>=1&&input.oids.length<=2000&&input.oids.every(oid))query={op:'stat',oids:[...new Set<string>(input.oids)].sort()};else if(input?.op==='head'||input?.op==='authorize')query={op:input.op};else throw new Fault(400,'Use authorize, head, object or a bounded stat batch');
   const project=match[1],expiresAt=await authorize(project,authorization);
   if(query.op==='authorize')return response({bytes:Buffer.from(JSON.stringify({project,expiresAt})),headers:{'content-type':'application/json'}},'lease');
   if(query.op==='head'){const {r,finish,deadline}=await send(project,authorization,query);try{return response({bytes:await Promise.race([readSmall(r,4096),deadline]),headers:{'content-type':'application/json'}},'live');}finally{finish();}}
   const key=project+'/'+sha(JSON.stringify(query)),cacheKey=new Request('https://squa.li/__regional_cache/v1/'+key);
   try{const hit=await bounded(options.cache.match(cacheKey));if(hit){const entry={bytes:await readSmall(hit,Math.max(cap,512*1024)),headers:Object.fromEntries(['content-type','x-squali-type','x-squali-oid'].flatMap(k=>hit.headers.has(k)?[[k,hit.headers.get(k)!]]:[]))};verify(query,entry);return response(entry,'hit');}}catch{throw new Fault(503,'Regional cache unavailable or corrupt; no source bypass');}
   const failed=failures.get(key);if(failed&&failed.until>now())throw failed.error;
   const running=flights.get(key);if(running){const value=await running;if('stream' in value)throw new Fault(503,'Large object stream is already in progress');return response(value,'coalesced');}
   const pending=load(project,authorization,query,key,cacheKey);flights.set(key,pending);let streaming=false;
   try{const value=await pending;if('stream' in value){streaming=true;return value.response;}return response(value,'miss');}
   catch(error){const failure=error instanceof Fault?error:new Fault(503,'Regional RPC failed');boundedSet(failures,key,{until:now()+5000,error:failure});throw failure;}
   finally{if(!streaming)flights.delete(key);}
  }catch(error){return error instanceof Fault?fault(error.status,error.message):fault(503,'Regional RPC unavailable');}
  finally{active--;}
 };
}

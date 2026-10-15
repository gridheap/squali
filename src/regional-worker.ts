import {regionalRpc} from './regional-cache.ts';

interface RegionalEnv {SOURCE:{fetch(request:Request):Promise<Response>};SOURCE_LIMIT:{limit(input:{key:string}):Promise<{success:boolean}>}}
// A binding identity changes when its environment changes. Never retain one
// deployment's source binding or admission counter for another environment.
const gateways=new WeakMap<RegionalEnv,Promise<ReturnType<typeof regionalRpc>>>();
export default {
 async fetch(request:Request,env:RegionalEnv){
  // Cloudflare routes support a trailing wildcard, not an infix wildcard.
  // Production owns /api/regional/*; keep passthrough for old deployments
  // and local fixtures during the ordered route migration.
  if(!new URL(request.url).pathname.endsWith('/rpc')){
   const started=performance.now(),response=await env.SOURCE.fetch(request);
   if(!response.headers.has('server-timing'))return response;
   const forwarded=new Response(response.body,response);forwarded.headers.append('server-timing',`regional;dur=${(performance.now()-started).toFixed(2)}`);return forwarded;
  }
  let pending=gateways.get(env);
  if(!pending){pending=caches.open('squali-regional-v1').then(cache=>regionalRpc({upstream:env.SOURCE,cache,admit:async()=>(await env.SOURCE_LIMIT.limit({key:'source-rpc'})).success,maxUpstream:8}));gateways.set(env,pending);}
  try{return await (await pending)(request);}catch{gateways.delete(env);return Response.json({error:'regional_unavailable',message:'Regional cache is unavailable; no origin bypass'},{status:503,headers:{'cache-control':'private, no-store','x-squali-tier':'regional'}});}
 }
};

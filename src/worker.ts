/// <reference path="../worker-configuration.d.ts" />
import {connectDatabase,databaseReady} from './database.ts';
import {sourceStore} from './source-store.ts';
import {createApp} from './app.ts';
import {r2ObjectCache} from './r2-cache.ts';
import {cachedArtifacts,edgeCache,memoryCache} from './cache.ts';
import {cloudArtifacts} from './cloud-artifacts.ts';
import type {Principal} from './types.ts';
import {WorkerEntrypoint} from 'cloudflare:workers';
interface WorkerEnv {
 REGIONAL?:Fetcher;
 NATIVE_IMPORTS?:string; SOURCE?:R2Bucket; MONTHLY_SOURCE_READ_CAP?:string; MONTHLY_SOURCE_WRITE_CAP?:string; SOURCE_REPOSITORY_BYTE_CAP?:string;
 ARTIFACTS:Artifacts; ASSETS:Fetcher; OBJECTS:R2Bucket; MONTHLY_R2_READ_CAP:string; MONTHLY_R2_WRITE_CAP:string; DATABASE_URL?:string; HYPERDRIVE?:{connectionString:string};
 CLERK_PUBLISHABLE_KEY?:string; CLERK_SECRET_KEY?:string; CLERK_JWT_KEY?:string;
 PRINCIPALS_JSON:string; MAX_PROJECTS:string; MONTHLY_ARTIFACT_CALL_CAP:string; ADOBE_KIT_ID?:string;
}
const isolateObjects=memoryCache();
async function sourceFetch(request:Request,env:WorkerEnv,ctx:ExecutionContext){
  if(!new URL(request.url).pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  const started=performance.now();
  const database=env.HYPERDRIVE?.connectionString??env.DATABASE_URL;
  if(!database||!env.PRINCIPALS_JSON)return Response.json({error:'not_configured',message:'Configure PostgreSQL and access principals before using Squali.'},{status:503});
  const sql=connectDatabase(database,{max:1,idle_timeout:5,connect_timeout:10,connection:{search_path:'weave'}});
  try{
   const regional=edgeCache(await caches.open('squali-source-v1'));const sourceCache={async get(key:string){const hit=await isolateObjects.get(key);if(hit!==undefined)return hit;const value=await regional.get(key);if(value!==undefined)await isolateObjects.set(key,value);return value;},async set(key:string,value:unknown){await regional.set(key,value);await isolateObjects.set(key,value);}};
   const principals=JSON.parse(env.PRINCIPALS_JSON) as Record<string,Principal>;
   const app=createApp({sql,databaseReady:databaseReady(sql),nativeImports:env.NATIVE_IMPORTS==='true',source:env.SOURCE?sourceStore(sql,env.SOURCE,{reads:Number(env.MONTHLY_SOURCE_READ_CAP),writes:Number(env.MONTHLY_SOURCE_WRITE_CAP),repositoryBytes:Number(env.SOURCE_REPOSITORY_BYTE_CAP)},sourceCache):undefined,clerk:env.CLERK_SECRET_KEY&&env.CLERK_PUBLISHABLE_KEY?{publishableKey:env.CLERK_PUBLISHABLE_KEY,secretKey:env.CLERK_SECRET_KEY,jwtKey:env.CLERK_JWT_KEY,appOrigin:'https://squa.li'}:undefined,artifacts:cachedArtifacts(cachedArtifacts(cachedArtifacts(cloudArtifacts(env.ARTIFACTS,sql,Number(env.MONTHLY_ARTIFACT_CALL_CAP)),r2ObjectCache(env.OBJECTS,sql,{reads:Number(env.MONTHLY_R2_READ_CAP),writes:Number(env.MONTHLY_R2_WRITE_CAP)})),edgeCache(await caches.open('weave-objects-v1'))),isolateObjects),principals,mode:'Cloudflare Workers + Artifacts + R2 + PostgreSQL',maxProjects:Number(env.MAX_PROJECTS),monthlyOps:Number(env.MONTHLY_ARTIFACT_CALL_CAP),cacheBudget:{reads:Number(env.MONTHLY_R2_READ_CAP),writes:Number(env.MONTHLY_R2_WRITE_CAP)},adobeKit:env.ADOBE_KIT_ID});
   const setup=performance.now()-started,response=await app(request);
   if(response.headers.has('server-timing'))response.headers.append('server-timing',`setup;dur=${setup.toFixed(2)}, worker;dur=${(performance.now()-started).toFixed(2)}`);
   return response;
  }finally{ctx.waitUntil(sql.end({timeout:5}));}
}
/** Only the regional service binding uses this entrypoint. It always executes
 * source authentication, and cannot loop through the compatibility gateway. */
export class SourceRpc extends WorkerEntrypoint<WorkerEnv>{
 fetch(request:Request){
  if(request.method!=='POST'||!/^\/api\/projects\/[^/]+\/rpc$/.test(new URL(request.url).pathname))return Promise.resolve(new Response('RPC endpoint only',{status:404}));
  return sourceFetch(request,this.env,this.ctx);
 }
}
export default {
 async fetch(request:Request,env:WorkerEnv,ctx:ExecutionContext){
  const url=new URL(request.url);
  if(env.REGIONAL&&/^\/api\/(?:regional\/)?projects\/[^/]+\/rpc$/.test(url.pathname)){
   url.pathname=url.pathname.replace(/^\/api\/(?:regional\/)?projects\//,'/api/regional/projects/');
   try{return await env.REGIONAL.fetch(new Request(url,request));}
   catch{return Response.json({error:'regional_unavailable',message:'Regional RPC unavailable; no source fallback'},{status:503,headers:{'cache-control':'private, no-store'}});}
  }
  return sourceFetch(request,env,ctx);
 }
};

/// <reference path="../worker-configuration.d.ts" />
import postgres from 'postgres';
import {createApp} from './app.ts';
import {r2ObjectCache} from './r2-cache.ts';
import {cachedArtifacts,edgeCache,memoryCache} from './cache.ts';
import {cloudArtifacts} from './cloud-artifacts.ts';
import type {Principal} from './types.ts';
interface WorkerEnv {
 ARTIFACTS:Artifacts; ASSETS:Fetcher; OBJECTS:R2Bucket; MONTHLY_R2_READ_CAP:string; MONTHLY_R2_WRITE_CAP:string; DATABASE_URL?:string; HYPERDRIVE?:{connectionString:string};
 CLERK_PUBLISHABLE_KEY?:string; CLERK_SECRET_KEY?:string; CLERK_JWT_KEY?:string;
 PRINCIPALS_JSON:string; MAX_PROJECTS:string; MONTHLY_ARTIFACT_CALL_CAP:string; ADOBE_KIT_ID?:string;
}
const isolateObjects=memoryCache();
export default {
 async fetch(request:Request,env:WorkerEnv,ctx:ExecutionContext){
  if(!new URL(request.url).pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  const database=env.HYPERDRIVE?.connectionString??env.DATABASE_URL;
  if(!database||!env.PRINCIPALS_JSON)return Response.json({error:'not_configured',message:'Configure PostgreSQL and access principals before using Squali.'},{status:503});
  const sql=postgres(database,{max:3,prepare:false,fetch_types:true,idle_timeout:5,connect_timeout:10,connection:{search_path:'weave'}});
  try{
   const principals=JSON.parse(env.PRINCIPALS_JSON) as Record<string,Principal>;
   return await createApp({sql,clerk:env.CLERK_SECRET_KEY&&env.CLERK_PUBLISHABLE_KEY?{publishableKey:env.CLERK_PUBLISHABLE_KEY,secretKey:env.CLERK_SECRET_KEY,jwtKey:env.CLERK_JWT_KEY,appOrigin:'https://squa.li'}:undefined,artifacts:cachedArtifacts(cachedArtifacts(cachedArtifacts(cloudArtifacts(env.ARTIFACTS,sql,Number(env.MONTHLY_ARTIFACT_CALL_CAP)),r2ObjectCache(env.OBJECTS,sql,{reads:Number(env.MONTHLY_R2_READ_CAP),writes:Number(env.MONTHLY_R2_WRITE_CAP)})),edgeCache(await caches.open('weave-objects-v1'))),isolateObjects),principals,mode:'Cloudflare Workers + Artifacts + R2 + PostgreSQL',maxProjects:Number(env.MAX_PROJECTS),monthlyOps:Number(env.MONTHLY_ARTIFACT_CALL_CAP),cacheBudget:{reads:Number(env.MONTHLY_R2_READ_CAP),writes:Number(env.MONTHLY_R2_WRITE_CAP)},adobeKit:env.ADOBE_KIT_ID})(request);
  }finally{ctx.waitUntil(sql.end({timeout:5}));}
 }
};

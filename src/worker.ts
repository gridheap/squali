/// <reference path="../worker-configuration.d.ts" />
import postgres from 'postgres';
import {createApp} from './app.ts';
import {cachedArtifacts,edgeCache} from './cache.ts';
import {cloudArtifacts} from './cloud-artifacts.ts';
import type {Principal} from './types.ts';
interface WorkerEnv {
 ARTIFACTS:Artifacts; ASSETS:Fetcher; DATABASE_URL?:string; HYPERDRIVE?:{connectionString:string};
 PRINCIPALS_JSON:string; MAX_PROJECTS:string; MONTHLY_ARTIFACT_CALL_CAP:string; ADOBE_KIT_ID?:string;
}
export default {
 async fetch(request:Request,env:WorkerEnv,ctx:ExecutionContext){
  if(!new URL(request.url).pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  const database=env.HYPERDRIVE?.connectionString??env.DATABASE_URL;
  if(!database||!env.PRINCIPALS_JSON)return Response.json({error:'not_configured',message:'Configure PostgreSQL and access principals before using Squali.'},{status:503});
  const sql=postgres(database,{max:3,prepare:false,fetch_types:true,idle_timeout:5,connect_timeout:10,connection:{search_path:'weave'}});
  try{
   const principals=JSON.parse(env.PRINCIPALS_JSON) as Record<string,Principal>;
   return await createApp({sql,artifacts:cachedArtifacts(cloudArtifacts(env.ARTIFACTS,sql,Number(env.MONTHLY_ARTIFACT_CALL_CAP)),edgeCache(await caches.open('weave-objects-v1'))),principals,mode:'Cloudflare Workers + Artifacts + PostgreSQL',maxProjects:Number(env.MAX_PROJECTS),monthlyOps:Number(env.MONTHLY_ARTIFACT_CALL_CAP),adobeKit:env.ADOBE_KIT_ID})(request);
  }finally{ctx.waitUntil(sql.end({timeout:5}));}
 }
};

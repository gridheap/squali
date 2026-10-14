import {Problem,type Config,type Principal} from './types.ts';
import {sha256} from './git.ts';
const MAX_SECONDS=8*60*60;
export function nativeImports(config:Config,owner:string){
 const sql=config.sql;
 async function run(initial:any,checkOnly=false){
  if(!config.source)throw new Problem(503,'source_unavailable','Source storage is unavailable');
  return sql.begin(async tx=>{
   const [row]=await tx`SELECT * FROM weave_github_imports WHERE id=${initial.id} AND owner_id=${owner} FOR UPDATE`;
   if(!row)throw new Problem(404,'import_missing','Import not found');
   if(row.state==='complete')return row;
   const [job]=await tx`SELECT * FROM weave_native_jobs WHERE import_id=${row.id} FOR UPDATE`;
   if(job&&['queued','running'].includes(job.state))return row;
   if(checkOnly)throw new Problem(409,'import_incomplete','Native import has not finished');
   if(row.native_attempts>=3)throw new Problem(429,'import_attempts','Three native attempts used; the deployment owner must inspect the retained journal');
   if(job?.elapsed_seconds>=MAX_SECONDS)throw new Problem(429,'import_time','The cumulative eight-hour execution budget is exhausted');
   if(row.metadata.size>2*1024*1024)throw new Problem(413,'import_size','Native imports admit at most 2 GiB of reported Git storage');
   await tx`SELECT pg_advisory_xact_lock(hashtextextended('weave-projects',0))`;
   const [project]=await tx`SELECT * FROM weave_projects WHERE id=${row.project_id}`;
   if(project&&(project.owner_id!==owner||project.storage!=='source'))throw new Problem(409,'import_migration','The existing destination needs an explicit source migration');
   if(!project){const [{count}]=await tx`SELECT count(*) FROM weave_projects`;if(Number(count)>=config.maxProjects)throw new Problem(429,'project_cap','Workspace allocation cap reached');
    await tx`INSERT INTO weave_projects(id,name,artifact,request_hash,owner_id,main_ref,storage,state) VALUES(${row.project_id},${row.metadata.full_name},${'weave-'+row.project_id},${sha256(row.id)},${owner},${'refs/heads/'+(row.metadata.default_branch??'main')},'source','importing')`;
   }
   await tx`INSERT INTO weave_native_jobs(import_id) VALUES(${row.id}) ON CONFLICT(import_id) DO UPDATE SET state='queued',pause_requested=false,lease=NULL,lease_until=NULL,token_id=NULL,updated_at=now()`;
   const [queued]=await tx`UPDATE weave_github_imports SET engine='source',state='queued',error=NULL,updated_at=now() WHERE id=${row.id} RETURNING *`;
   await tx`SELECT pg_notify('squali_native_jobs','ready')`;return queued;
  });
 }
 async function pause(id:string){return sql.begin(async tx=>{
  const [row]=await tx`SELECT * FROM weave_github_imports WHERE id=${id} AND owner_id=${owner} FOR UPDATE`;if(!row)throw new Problem(404,'import_missing','Import not found');
  if(row.engine!=='source')throw new Problem(409,'import_engine','This import uses the legacy transfer engine');
  const [job]=await tx`UPDATE weave_native_jobs SET pause_requested=true,state=CASE WHEN state='queued' THEN 'paused' ELSE state END,updated_at=now() WHERE import_id=${id} AND state IN ('queued','running') RETURNING *`;
  if(job){await tx`UPDATE weave_tokens SET revoked_at=now() WHERE id=${job.token_id}`;await tx`UPDATE weave_github_imports SET state=${job.state==='queued'||job.state==='paused'?'paused':'pausing'},updated_at=now() WHERE id=${id}`;}
  return {id,state:job?.state==='running'?'pausing':job?.state??row.state};
 });}
 return {run,pause};
}
export async function nativeJobCredential(config:Config,principal:Principal,project:string,lease:unknown){
 if(typeof lease!=='string'||lease.length>100)throw new Problem(403,'job_lease','A live native job lease is required');
 const [job]=await config.sql`SELECT j.import_id,i.owner_id FROM weave_native_jobs j JOIN weave_github_imports i ON i.id=j.import_id WHERE i.project_id=${project} AND j.state='running' AND NOT j.pause_requested AND j.lease=${lease} AND j.lease_until>now() AND ${principal.id}='agent:'||j.token_id`;
 if(!job)throw new Problem(403,'job_lease','Only the leased native runner may retrieve this credential');return job;
}

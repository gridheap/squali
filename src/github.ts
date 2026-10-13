import type {Config,Principal} from './types.ts';
import {Problem} from './types.ts';
import {sha256} from './git.ts';
import {advertisedRefs,sourceRefs,sourcePack,limitedBytes} from './git-transfer.ts';
import type {GitRef} from './git-transfer.ts';
const MAX_PACK=256*1024*1024;
const view=(r:any)=>({id:r.id,repositoryId:Number(r.repository_id),projectId:r.project_id,repository:r.metadata.full_name,private:r.metadata.private,state:r.state,head:r.head,attempts:r.attempts,bytes:r.state==='complete'&&Number(r.bytes)===0&&r.refs?.length?null:Number(r.bytes),error:r.error});
export function githubService(config:Config,principal:Principal){
 if(!principal.owner||!config.clerk)throw new Problem(403,'github_login','Sign in with GitHub through Clerk to import your repositories');
 const owner=principal.owner,sql=config.sql;const apiOrigin=config.github?.apiOrigin??'https://api.github.com';const gitOrigin=config.github?.gitOrigin??'https://github.com';
 async function reserve(){const rows=await sql`INSERT INTO weave_provider_usage(owner_id,day,attempts) VALUES(${owner},CURRENT_DATE,1) ON CONFLICT(owner_id,day) DO UPDATE SET attempts=weave_provider_usage.attempts+1 WHERE weave_provider_usage.attempts<500 RETURNING attempts`;if(!rows.length)throw new Problem(429,'github_budget','Daily GitHub integration request limit reached');}
 async function githubToken(){
  await reserve();const response=await fetch((config.clerk!.apiOrigin??'https://api.clerk.com')+'/v1/users/'+encodeURIComponent(owner.slice(6))+'/oauth_access_tokens/oauth_github',{headers:{authorization:'Bearer '+config.clerk!.secretKey},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok){await response.body?.cancel();throw new Problem(403,'github_connection','Reconnect GitHub to grant repository access');}
  const values=JSON.parse((await limitedBytes(response,65536)).toString());const connected=(Array.isArray(values)?values:values.data)?.[0];
  if(!connected?.token)throw new Problem(403,'github_connection','Connect your GitHub account first');return connected.token as string;
 }
 async function request(path:string,token:string){await reserve();const res=await fetch(apiOrigin+path,{headers:{authorization:'Bearer '+token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'Squali'},redirect:'error',signal:AbortSignal.timeout(15000)});if(res.status===429||res.status===403&&res.headers.get('x-ratelimit-remaining')==='0'){await res.body?.cancel();throw new Problem(429,'github_rate_limit','GitHub rate limit reached; retry later. No automatic retries run.');}return res;}
 async function catalog(page:number){
  if(!Number.isInteger(page)||page<1||page>100)throw new Problem(400,'page_limit','Repository pages must be between 1 and 100');
  const [cached]=await sql`SELECT payload FROM weave_github_catalog WHERE owner_id=${owner} AND page=${page} AND expires_at>now()`;if(cached)return cached.payload;
  const token=await githubToken();const response=await request(`/user/repos?per_page=100&page=${page}&sort=full_name&direction=asc&affiliation=owner,collaborator,organization_member`,token);const next=!!response.headers.get('link')?.includes('rel="next"');
  const values=JSON.parse((await limitedBytes(response,2*1024*1024)).toString());if(!Array.isArray(values))throw new Problem(502,'github_catalog','Invalid repository list');
  const repositories=values.filter(r=>r.permissions?.pull!==false).map(r=>({id:r.id,full_name:r.full_name,private:!!r.private,default_branch:r.default_branch,size:r.size,archived:!!r.archived}));
  const payload={repositories,nextPage:next?page+1:null,truncated:next&&page===100};
  await sql`INSERT INTO weave_github_catalog(owner_id,page,payload,expires_at) VALUES(${owner},${page},${sql.json(payload)},now()+interval '15 minutes') ON CONFLICT(owner_id,page) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`;return payload;
 }
 async function list(){return {imports:(await sql`SELECT * FROM weave_github_imports WHERE owner_id=${owner} ORDER BY created_at,id LIMIT 1000`).map(view)};}
 async function enqueue(ids:unknown){
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>!Number.isSafeInteger(id)||id<1))throw new Problem(400,'repository_ids','Select 1–1,000 repository IDs');
  const unique=[...new Set(ids)] as number[];const pages=await sql`SELECT payload FROM weave_github_catalog WHERE owner_id=${owner} AND expires_at>now()`;const available=new Map<number,any>(pages.flatMap(p=>p.payload.repositories.map((r:any)=>[r.id,r])));
  if(unique.some(id=>!available.has(id)))throw new Problem(409,'refresh_catalog','Refresh the repository list before importing');
  await sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${owner+'-import-queue'},0))`;const [{count}]=await tx`SELECT count(*) FROM weave_github_imports WHERE owner_id=${owner}`;const existing=await tx`SELECT repository_id FROM weave_github_imports WHERE owner_id=${owner} AND repository_id=ANY(${unique})`;if(Number(count)+unique.length-existing.length>1000)throw new Problem(429,'queue_limit','At most 1,000 import records per account');
   for(const rid of unique){const hash=sha256(owner+':github:'+rid);await tx`INSERT INTO weave_github_imports(id,owner_id,repository_id,project_id,metadata) VALUES(${'imp_'+hash.slice(0,24)},${owner},${rid},${'gh-'+hash.slice(0,24)},${tx.json(available.get(rid))}) ON CONFLICT(owner_id,repository_id) DO NOTHING`;}
  });return {imports:(await sql`SELECT * FROM weave_github_imports WHERE owner_id=${owner} AND repository_id=ANY(${unique}) ORDER BY created_at,id`).map(view)};
 }
 async function run(id:string){
  const [initial]=await sql`SELECT * FROM weave_github_imports WHERE id=${id} AND owner_id=${owner}`;if(!initial)throw new Problem(404,'import_missing','Import not found');if(initial.state==='complete')return view(initial);
  // PostgreSQL releases the lock on process death. Durable refs permit safe reconciliation of a late push.
  return sql.begin(async tx=>{
   const [{available}]=await tx`SELECT pg_try_advisory_xact_lock(hashtextextended('squali-import-capacity',0)) AS available`;if(!available)throw new Problem(409,'import_capacity','Another repository is importing. Resume when it finishes.');
   const [{locked}]=await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${id},0)) AS locked`;if(!locked)throw new Problem(409,'import_busy','This repository is already being imported');
   let [row]=await sql`SELECT * FROM weave_github_imports WHERE id=${id}`;if(row.state==='complete')return view(row);
   const finish=async(head:string|null,bytes:number)=>{await sql.begin(async done=>{await done`UPDATE weave_projects SET state='ready',head=${head} WHERE id=${row.project_id}`;await done`UPDATE weave_github_imports SET state='complete',head=${head},bytes=${bytes},error=NULL,updated_at=now() WHERE id=${id}`;});return view((await sql`SELECT * FROM weave_github_imports WHERE id=${id}`)[0]);};
   try{
    const [project]=await sql`SELECT * FROM weave_projects WHERE id=${row.project_id}`;
    if(project&&row.refs){
     try{const dest=await advertisedRefs(await config.artifacts.repo(project.artifact).git(new Request('https://squali.invalid'),'/info/refs?service=git-upload-pack'));const known=new Map(dest.map(r=>[r.name,r.oid]));if((row.refs as GitRef[]).every(r=>known.get(r.name)===r.oid)){return finish(row.head,Number(row.bytes));}}
     catch(error){if(!(error instanceof Problem&&error.status===404)&&(error as {code?:string}).code!=='NOT_FOUND')throw error;}
    }
    if(row.attempts>=3)throw new Problem(429,'import_attempts','Three transfer attempts used. Contact the deployment owner before retrying.');
    await sql`UPDATE weave_github_imports SET state='running',attempts=attempts+1,error=NULL,updated_at=now() WHERE id=${id}`;
    const token=await githubToken();const response=await request('/repositories/'+row.repository_id,token);const meta=JSON.parse((await limitedBytes(response,262144)).toString());
    if(Number(meta.id)!==Number(row.repository_id)||!/^[-\w.]+\/[-\w.]+$/.test(meta.full_name)||meta.permissions?.pull===false)throw new Problem(403,'github_access','GitHub no longer grants access to this repository');
    if(meta.size>MAX_PACK/1024)throw new Problem(413,'import_size','Repository exceeds the current 256 MiB import limit');
    const remote=gitOrigin+'/'+meta.full_name+'.git';if(!row.refs)await reserve();const refs:GitRef[]=row.refs??await sourceRefs(remote,token);const branch=project?.main_ref?.replace(/^refs\/heads\//,'')||(row.refs?row.metadata.default_branch:meta.default_branch)||'main';const mainRef='refs/heads/'+branch;const head=refs.find(r=>r.name===mainRef)?.oid??null;
    if(refs.length&&!head)throw new Problem(409,'default_branch','The default branch changed; refresh the repository before importing');
    await sql.begin(async allocate=>{await allocate`SELECT pg_advisory_xact_lock(hashtextextended('weave-projects',0))`;const [p]=await allocate`SELECT id FROM weave_projects WHERE id=${row.project_id}`;if(!p){const [{count}]=await allocate`SELECT count(*) FROM weave_projects`;if(Number(count)>=config.maxProjects)throw new Problem(429,'project_cap','Workspace allocation cap reached');await allocate`INSERT INTO weave_projects(id,name,artifact,request_hash,owner_id,main_ref) VALUES(${row.project_id},${meta.full_name},${'weave-'+row.project_id},${sha256(id)},${owner},${mainRef})`;}});
    await sql`UPDATE weave_github_imports SET refs=${sql.json(refs)},head=${head},metadata=${sql.json(meta)},updated_at=now() WHERE id=${id}`;
    const artifact='weave-'+row.project_id;await config.artifacts.create(artifact,branch);const repo=config.artifacts.repo(artifact);const current=await advertisedRefs(await repo.git(new Request('https://squali.invalid'),'/info/refs?service=git-upload-pack'));const known=new Map(current.map(r=>[r.name,r.oid]));const expected=new Map(refs.map(r=>[r.name,r.oid]));const missing=refs.filter(r=>known.get(r.name)!==r.oid);
    if(current.some(d=>expected.get(d.name)!==d.oid))throw new Problem(409,'destination_changed','The destination contains different refs; import stopped without overwriting them');
    const info=await repo.info();await sql`UPDATE weave_projects SET remote=${info.remote} WHERE id=${row.project_id}`;
    let bytes=0;if(missing.length){await reserve();const pack=await sourcePack(remote,token,refs,MAX_PACK);await repo.receive(missing,pack.stream);bytes=pack.bytes();}
    return finish(head,bytes);
   }catch(error){const problem=error instanceof Problem?error:new Problem(502,'import_interrupted','Import interrupted. Resume checks the destination before transferring again.');await sql`UPDATE weave_github_imports SET state='failed',error=${problem.message},updated_at=now() WHERE id=${id}`;throw problem;}
  });
 }
 return {catalog,enqueue,list,run};
}

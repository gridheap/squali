import {GitSession,sha256,validPath} from './git.ts';
import {Problem} from './types.ts';
import {changeService,changeView,publicationView} from './changes.ts';
import type {Config,Patch,Principal,Sql} from './types.ts';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const id=(value:unknown)=>{if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value))throw new Problem(400,'invalid_id','Use 1–63 letters, numbers, hyphens or underscores');return value;};
const text=(value:unknown,max=200,optional=false)=>{if(typeof value!=='string'||value.length>max||(!optional&&!value.trim()))throw new Problem(400,'invalid_text',`Text must contain ${optional?0:1}–${max} characters`);return value;};
function patches(value:unknown):Patch[]{
 if(!Array.isArray(value)||value.length>64)throw new Problem(400,'invalid_files','At most 64 files may change at once');const seen=new Set<string>();let bytes=0;
 for(const file of value){validPath(file?.path);if(seen.has(file.path))throw new Problem(400,'duplicate_path','File paths must be unique');seen.add(file.path);if(file.content!==null&&typeof file.content!=='string')throw new Problem(400,'invalid_content','File content must be UTF-8 text or null for deletion');if(typeof file.content==='string'&&file.content.includes('\0'))throw new Problem(422,'binary_file','The editing API accepts UTF-8 text only');if(file.mode&&!['100644','100755'].includes(file.mode))throw new Problem(400,'invalid_mode','Unsupported file mode');bytes+=Buffer.byteLength(file.content??'');if(Buffer.byteLength(file.content??'')>256*1024||bytes>1024*1024)throw new Problem(413,'file_limit','Limit: 256 KiB per file and 1 MiB per changeset');}
 return value;
}
async function body(request:Request){
 if(!request.headers.get('content-type')?.includes('application/json'))throw new Problem(415,'content_type','Use application/json');
 const reader=request.body?.getReader();let n=0;const chunks=[];if(!reader)throw new Problem(400,'invalid_json','Missing request body');while(true){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>2*1024*1024){await reader.cancel();throw new Problem(413,'payload_limit','Request exceeds 2 MiB');}chunks.push(Buffer.from(value));}
 try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Problem(400,'invalid_json','Invalid JSON');}
}
const projectView=(r:any)=>({id:r.id,name:r.name,head:r.head,remote:r.remote,state:r.state});
export function createApp(config:Config){
 const {sql,artifacts}=config;
 const getProject=async(pid:string)=>{const [p]=await sql`SELECT * FROM weave_projects WHERE id=${pid}`;if(!p)throw new Problem(404,'project_missing','Workspace not found');if(p.state!=='ready')throw new Problem(409,'project_pending','Workspace initialization is incomplete; retry the original creation request');return p;};
 return async(request:Request):Promise<Response>=>{
  const start=performance.now();
  try{
   const url=new URL(request.url);if(!url.pathname.startsWith('/api/')){const res=await config.assets?.(request)??new Response('Weave API',{status:200});res.headers.set('x-content-type-options','nosniff');res.headers.set('referrer-policy','no-referrer');res.headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' https://use.typekit.net https://p.typekit.net; font-src 'self' https://use.typekit.net; connect-src 'self' https://use.typekit.net https://p.typekit.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");return res;}
   const auth=request.headers.get('authorization')??'';const principal=config.principals[sha256(auth.startsWith('Bearer ')?auth.slice(7):'')];if(!principal)throw new Problem(401,'unauthorized','Connect with a valid access token');
   const mutating=request.method!=='GET';if(mutating&&request.headers.has('origin')&&request.headers.get('origin')!==url.origin)throw new Problem(403,'origin','Cross-origin mutations are forbidden');
   const parts=url.pathname.split('/').filter(Boolean);const resource=parts[1],pid=parts[2];if(pid){id(pid);if(!principal.projects.includes('*')&&!principal.projects.includes(pid))throw new Problem(403,'scope','This token cannot access this workspace');}
   const requireRole=(roles:string[])=>{if(!roles.includes(principal.role))throw new Problem(403,'role','Your role does not allow this operation');};
   if(resource==='usage'&&request.method==='GET'){const [usage]=await sql`SELECT attempts FROM weave_usage WHERE month=${new Date().toISOString().slice(0,7)}`;return json({attempts:Number(usage?.attempts??0),cap:config.monthlyOps,mode:config.mode});}
   if(resource==='session'&&request.method==='GET')return json({principal,mode:config.mode,adobeKit:config.adobeKit??null});
   if(resource==='projects'&&!pid&&request.method==='GET'){const rows=principal.projects.includes('*')?await sql`SELECT * FROM weave_projects WHERE state='ready' ORDER BY created_at DESC LIMIT 100`:await sql`SELECT * FROM weave_projects WHERE state='ready' AND id=ANY(${principal.projects}) ORDER BY created_at DESC LIMIT 100`;return json({projects:rows.map(projectView)});}
   if(resource==='projects'&&!pid&&request.method==='POST'){
    requireRole(['admin']);const input=await body(request);const projectId=id(input.id);if(!principal.projects.includes('*')&&!principal.projects.includes(projectId))throw new Problem(403,'scope','Token cannot create this workspace');const name=text(input.name);const files=patches(input.files??[]);const hash=sha256(JSON.stringify({id:projectId,name,files}));
    await sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended('weave-projects',0))`;const [exists]=await tx`SELECT id FROM weave_projects WHERE id=${projectId}`;if(!exists){const [{count}]=await tx`SELECT count(*) FROM weave_projects`;if(Number(count)>=config.maxProjects)throw new Problem(429,'project_cap','Workspace allocation cap reached');await tx`INSERT INTO weave_projects(id,name,artifact,request_hash) VALUES(${projectId},${name},${'weave-'+projectId},${hash})`;}});
    const result=await sql.begin(async tx=>{
     const [p]=await tx`SELECT * FROM weave_projects WHERE id=${projectId} FOR UPDATE`;if(p.request_hash!==hash)throw new Problem(409,'idempotency_mismatch','Workspace ID already used with different input');if(p.state==='ready')return projectView(p);
     await artifacts.create(p.artifact);const repo=artifacts.repo(p.artifact),g=new GitSession(repo);const built=await g.build(null,files,'Initialize '+name,principal.id,Math.floor(new Date(p.created_at).getTime()/1000));const head=await repo.head();if(head!==built.oid)await repo.push('refs/heads/main',null,built.oid,built.pack);const {remote}=await repo.info();
     const [ready]=await tx`UPDATE weave_projects SET head=${built.oid},remote=${remote},state='ready' WHERE id=${projectId} RETURNING *`;return projectView(ready);
    });return json(result,201);
   }
   if(resource==='projects'&&pid){
    const p=await getProject(pid);const repo=artifacts.repo(p.artifact);const g=new GitSession(repo);const action=parts[3];
    if(action==='git'){
     const suffix='/'+parts.slice(4).join('/')+url.search;
     if(!((request.method==='GET'&&suffix==='/info/refs?service=git-upload-pack')||(request.method==='POST'&&suffix==='/git-upload-pack')))throw new Problem(403,'read_only_git','The Git gateway is read-only; propose writes through the changes API');
     if(request.method==='POST'){const b=await request.arrayBuffer();if(b.byteLength>1024*1024)throw new Problem(413,'git_request_limit','Git negotiation exceeds 1 MiB');request=new Request(request,{body:b});}
     const upstream=await repo.git(request,suffix);return new Response(upstream.body,{status:upstream.status,headers:{'content-type':upstream.headers.get('content-type')??'application/octet-stream','cache-control':'private, no-store'}});
    }
    const changes=changeService(config,p,principal);
    if(action==='changes'&&request.method==='GET'&&!parts[4]){
     const rows=await sql`SELECT * FROM weave_changes WHERE project=${pid} AND status<>'preparing' ORDER BY created_at DESC LIMIT 200`;
     const overlaps=await sql`SELECT a.change_id AS left_id,b.change_id AS right_id,a.path FROM weave_paths a JOIN weave_paths b ON a.project=b.project AND a.path=b.path AND a.change_id<b.change_id JOIN weave_changes ca ON ca.project=a.project AND ca.id=a.change_id JOIN weave_changes cb ON cb.project=b.project AND cb.id=b.change_id WHERE a.project=${pid} AND ca.status IN ('proposed','approved') AND cb.status IN ('proposed','approved') LIMIT 200`;
     return json({changes:rows.map(changeView),overlaps});
    }
    if(action==='changes'&&request.method==='POST'&&!parts[4]){
     requireRole(['admin','agent']);const b=await body(request);const deps=b.dependencies??[];if(!Array.isArray(deps)||deps.length>32||new Set(deps).size!==deps.length)throw new Problem(400,'dependencies','At most 32 unique dependencies');deps.forEach(id);
     const context=b.context??{};if(!context||typeof context!=='object'||Array.isArray(context)||Buffer.byteLength(JSON.stringify(context))>32768)throw new Problem(400,'context','Context must be an object up to 32 KiB');
     if(b.base!==undefined&&(typeof b.base!=='string'||!/^[a-f0-9]{40}$/.test(b.base)))throw new Problem(400,'invalid_ref','Base must be an immutable commit');
     return json(await changes.propose({id:id(b.id),title:text(b.title),intent:text(b.intent,4000),context,dependencies:deps,base:b.base,files:patches(b.files)}),201);
    }
    if(action==='changes'&&parts[4]&&request.method==='GET')return json(await changes.details(id(parts[4])));
    if(action==='changes'&&parts[5]==='revise'&&request.method==='POST'){requireRole(['admin','agent']);const b=await body(request);return json(await changes.revise(id(parts[4]),{id:id(b.id),files:patches(b.files),note:text(b.note,4000)}),201);}
    if(action==='changes'&&parts[5]==='review'&&request.method==='POST'){
     requireRole(['admin','reviewer']);const b=await body(request);if(!['approved','rejected','proposed'].includes(b.decision))throw new Problem(400,'decision','Choose approved, rejected or proposed');return json(await changes.review(id(parts[4]),b.decision,text(b.note??'',4000,true)));
    }
    if((action==='preview'||action==='publish')&&request.method==='POST'){
     if(action==='publish')requireRole(['admin','reviewer']);const b=await body(request);if(!Array.isArray(b.changes)||!b.changes.length||b.changes.length>64||new Set(b.changes).size!==b.changes.length)throw new Problem(400,'batch','Select 1–64 unique changes');b.changes.forEach(id);
     if(action==='preview'){const plan=await changes.preview(b.changes);return json({...plan,files:plan.files.map(f=>({path:f.path,bytes:Buffer.byteLength(f.content??''),deleted:f.content===null}))});}
     return json(await changes.publish({id:id(b.id),changes:b.changes,expectedHead:b.expectedHead}),201);
    }
    if(action==='events'&&request.method==='GET'){const after=Number(url.searchParams.get('after')??0);if(!Number.isSafeInteger(after)||after<0)throw new Problem(400,'cursor','Invalid cursor');return json({events:await sql`SELECT * FROM weave_events WHERE project=${pid} AND seq>${after} ORDER BY seq LIMIT 200`});}
    if(action==='publications'&&parts[5]==='abort'&&request.method==='POST'){requireRole(['admin','reviewer']);const b=await body(request);return json(await changes.abort(id(parts[4]),text(b.expectedHead,40),text(b.note,4000)));}
    if(action==='publications'&&request.method==='GET')return json({publications:(await sql`SELECT * FROM weave_publications WHERE project=${pid} ORDER BY created_at DESC LIMIT 100`).map(publicationView)});
    if(!action&&request.method==='GET')return json({...projectView(p),head:await repo.head()});
    if(action==='file'&&request.method==='GET'){const ref=url.searchParams.get('ref')??await repo.head()??p.head;const path=url.searchParams.get('path')??'';validPath(path);const content=await g.file(ref,path);if(content===null)throw new Problem(404,'file_missing','File not found');const entry=await g.entry(ref,path);return json({path,ref,content,oid:entry!.oid,mode:entry!.mode});}
    if(action==='tree'&&request.method==='GET'){const ref=url.searchParams.get('ref')??await repo.head()??p.head;const path=url.searchParams.get('path');const commit=await g.commit(ref);if(!commit)throw new Problem(404,'commit_missing','Commit not found');const entry=path?await g.entry(ref,path):null;if(path&&entry?.type!=='tree')throw new Problem(404,'tree_missing','Directory not found');return json({ref,path:path??'',entries:await g.tree(entry?.oid??commit.tree)});}
   }
   throw new Problem(404,'not_found','API route not found');
  }catch(e){if(e instanceof Problem)return json({error:e.code,message:e.message,details:e.details},e.status);console.error('request failed',e instanceof Error?e.message:'unknown');return json({error:'internal_error',message:'Request failed; retry with the same operation ID.'},500);}
 };
}

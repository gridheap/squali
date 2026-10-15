import {authorizePaths,canPath,containsPath,parseScopes,parseRules} from './permissions.ts';
import {metadataService} from './metadata.ts';
import {randomBytes} from 'node:crypto';
import {rebaseSeries} from './rebase-series.ts';
import {nativeJobCredential} from './native-imports.ts';
import {githubService} from './github.ts';
import {authenticate,clerkDomain} from './auth.ts';
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
async function gitBody(request:Request){
 const limit=1024*1024;
 const bounded=async(stream:ReadableStream<Uint8Array>|null)=>{const reader=stream?.getReader();const chunks:Buffer[]=[];let size=0;if(!reader)return Buffer.alloc(0);while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Problem(413,'git_request_limit','Git negotiation exceeds 1 MiB');}chunks.push(Buffer.from(value));}return Buffer.concat(chunks);};
 const encoding=request.headers.get('content-encoding')?.toLowerCase()??'identity';
 if(!['identity','gzip'].includes(encoding))throw new Problem(415,'git_encoding','Git negotiation accepts identity or gzip encoding');
 let data=await bounded(request.body);
 if(encoding==='gzip')try{data=await bounded(new Response(data).body!.pipeThrough(new DecompressionStream('gzip')));}catch(error){if(error instanceof Problem)throw error;throw new Problem(400,'git_encoding','Invalid compressed Git negotiation');}
 const headers=new Headers(request.headers);headers.delete('content-encoding');headers.delete('content-length');return new Request(request,{headers,body:data});
}
async function body(request:Request){
 if(!request.headers.get('content-type')?.includes('application/json'))throw new Problem(415,'content_type','Use application/json');
 const reader=request.body?.getReader();let n=0;const chunks=[];if(!reader)throw new Problem(400,'invalid_json','Missing request body');while(true){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>2*1024*1024){await reader.cancel();throw new Problem(413,'payload_limit','Request exceeds 2 MiB');}chunks.push(Buffer.from(value));}
 try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Problem(400,'invalid_json','Invalid JSON');}
}
const projectView=(r:any)=>({id:r.id,name:r.name,head:r.head,remote:r.remote,state:r.state,storage:r.storage??'artifacts'});
export function createApp(config:Config){
 if(config.source)config={...config,artifacts:config.source.artifacts(config.artifacts)};
 const {sql,artifacts}=config;
 const getProject=async(pid:string,allowImport=false)=>{const [p]=await sql`SELECT * FROM weave_projects WHERE id=${pid}`;if(!p)throw new Problem(404,'project_missing','Workspace not found');if(p.state!=='ready'&&!(allowImport&&p.state==='importing'&&p.storage==='source'))throw new Problem(409,'project_pending','Workspace initialization is incomplete; retry the original creation request');return p;};
 return async(request:Request):Promise<Response>=>{
  const start=performance.now();
  try{
   const url=new URL(request.url);if(!url.pathname.startsWith('/api/')){const res=await config.assets?.(request)??new Response('Squali API',{status:200});res.headers.set('x-content-type-options','nosniff');res.headers.set('referrer-policy','no-referrer');const clerkSource=config.clerk?' https://'+clerkDomain(config.clerk.publishableKey):'';res.headers.set('content-security-policy',`default-src 'self'; script-src 'self'${clerkSource}; style-src 'self' https://use.typekit.net https://p.typekit.net; font-src 'self' https://use.typekit.net; connect-src 'self'${clerkSource} https://use.typekit.net https://p.typekit.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);return res;}
   if(url.pathname==='/api/auth/config'&&request.method==='GET')return json({publishableKey:config.clerk?.publishableKey??null,nativeImports:!!config.nativeImports});
   const principal=await authenticate(request,config);
   const mutating=request.method!=='GET';if(mutating&&request.headers.has('origin')&&request.headers.get('origin')!==url.origin)throw new Problem(403,'origin','Cross-origin mutations are forbidden');
   const parts=url.pathname.split('/').filter(Boolean);const resource=parts[1],pid=parts[2];if(pid&&resource==='projects'){id(pid);if(principal.projects.includes('*')){const [owned]=await sql`SELECT owner_id FROM weave_projects WHERE id=${pid}`;if(owned?.owner_id)throw new Problem(403,'scope','Use a workspace-specific credential for personal workspaces');}if(!principal.projects.includes('*')&&!principal.projects.includes(pid))throw new Problem(403,'scope','This token cannot access this workspace');}
   if(resource==='github'){const gh=githubService(config,principal);if(parts[2]==='repositories'&&request.method==='GET')return json(await gh.catalog(Number(url.searchParams.get('page')??1)));if(parts[2]==='imports'){if(parts[3]&&parts[4]==='pause'&&request.method==='POST')return json(await gh.pause(id(parts[3])));if(parts[3]&&parts[4]==='reconcile'&&request.method==='POST')return json(await gh.reconcile(id(parts[3])));if(parts[3]&&parts[4]==='run'&&request.method==='POST')return json(await gh.run(id(parts[3])));if(!parts[3]&&request.method==='GET')return json(await gh.list());if(!parts[3]&&request.method==='POST')return json(await gh.enqueue((await body(request)).repositoryIds),201);}}
   const requireRole=(roles:string[])=>{if(!roles.includes(principal.role))throw new Problem(403,'role','Your role does not allow this operation');};
   if(resource==='usage'&&request.method==='GET'){const [usage]=await sql`SELECT attempts FROM weave_usage WHERE month=${new Date().toISOString().slice(0,7)}`;const cache=await sql`SELECT kind,reservations FROM weave_cache_usage WHERE month=${new Date().toISOString().slice(0,7)}`;const source=await sql`SELECT kind,attempts FROM weave_source_usage WHERE month=${new Date().toISOString().slice(0,7)}`;return json({source:{readCap:config.source?.caps.reads??0,writeCap:config.source?.caps.writes??0,reads:Number(source.find(r=>r.kind==='reads')?.attempts??0),writes:Number(source.find(r=>r.kind==='writes')?.attempts??0)},attempts:Number(usage?.attempts??0),cap:config.monthlyOps,mode:config.mode,cache:{reservedReads:Number(cache.find(r=>r.kind==='reads')?.reservations??0),reservedWrites:Number(cache.find(r=>r.kind==='writes')?.reservations??0),readCap:config.cacheBudget?.reads??null,writeCap:config.cacheBudget?.writes??null}});}
   if(resource==='session'&&request.method==='GET')return json({principal,mode:config.mode,adobeKit:config.adobeKit??null});
   if(resource==='projects'&&!pid&&request.method==='GET'){const rows=principal.projects.includes('*')?await sql`SELECT * FROM weave_projects WHERE state='ready' AND owner_id IS NULL ORDER BY created_at DESC LIMIT 100`:await sql`SELECT * FROM weave_projects WHERE state='ready' AND id=ANY(${principal.projects}) ORDER BY created_at DESC LIMIT 100`;return json({projects:rows.map(projectView)});}
   if(resource==='projects'&&!pid&&request.method==='POST'){
    requireRole(['admin']);const input=await body(request);const projectId=id(input.id);if(!principal.owner&&!principal.projects.includes('*')&&!principal.projects.includes(projectId))throw new Problem(403,'scope','Token cannot create this workspace');const name=text(input.name);const storage=input.storage??(config.source?'source':'artifacts');if(!['artifacts','source'].includes(storage)||storage==='source'&&!config.source)throw new Problem(400,'storage','Requested source storage is unavailable');const files=patches(input.files??[]);if(input.import&&(storage!=='source'||files.length))throw new Problem(400,'source_import','Import initialization requires an empty source workspace');const hash=sha256(JSON.stringify({id:projectId,name,files,...(storage==='source'?{storage,...(input.import?{import:true}:{})}:{})}));
    await sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended('weave-projects',0))`;const [exists]=await tx`SELECT id,owner_id FROM weave_projects WHERE id=${projectId}`;if(exists&&((principal.owner&&exists.owner_id!==principal.owner)||(!principal.owner&&exists.owner_id&&principal.projects.includes('*'))))throw new Problem(403,'scope','This workspace belongs to another account');if(!exists){const [{count}]=await tx`SELECT count(*) FROM weave_projects`;if(Number(count)>=config.maxProjects)throw new Problem(429,'project_cap','Workspace allocation cap reached');await tx`INSERT INTO weave_projects(id,name,artifact,request_hash,owner_id,storage) VALUES(${projectId},${name},${'weave-'+projectId},${hash},${principal.owner??null},${storage})`;}});
    const result=await (async()=>{
     const [p]=await sql`SELECT * FROM weave_projects WHERE id=${projectId}`;if(p.request_hash!==hash)throw new Problem(409,'idempotency_mismatch','Workspace ID already used with different input');if(p.state==='ready')return projectView(p);if(input.import){const [pending]=await sql`UPDATE weave_projects SET state='importing' WHERE id=${projectId} RETURNING *`;return projectView(pending);}
     await artifacts.create(p.artifact);const repo=artifacts.repo(p.artifact),g=new GitSession(repo);const built=await g.build(null,files,'Initialize '+name,principal.id,Math.floor(new Date(p.created_at).getTime()/1000));const head=await repo.head();if(head!==built.oid)await repo.push('refs/heads/main',null,built.oid,built.pack);const {remote}=await repo.info();
     const [ready]=await sql`UPDATE weave_projects SET head=${built.oid},remote=${remote},state='ready' WHERE id=${projectId} RETURNING *`;return projectView(ready);
    })();return json(result,201);
   }
   if(resource==='projects'&&pid){
    const p=await getProject(pid,parts[3]==='source');const storage=artifacts.repo(p.artifact);const repo={...storage,head:(ref?:string)=>storage.head(ref??p.main_ref)};const g=new GitSession(repo);const action=parts[3];
    const unrestricted=()=>{if(principal.paths)throw new Problem(403,'path_scope','This endpoint requires access to the whole workspace');};
    const checkChanges=async(ids:string[])=>{if(!principal.paths)return;const seen=new Set<string>();let pending=ids;while(pending.length){const next=[...new Set(pending)].filter(id=>!seen.has(id));if(!next.length)break;if(seen.size+next.length>64)throw new Problem(400,'scope_graph','Directory-scoped operations inspect at most 64 dependency records');next.forEach(id=>seen.add(id));const rows=await sql`SELECT files,dependencies FROM weave_changes WHERE project=${pid} AND id=ANY(${next})`;for(const row of rows)authorizePaths(principal,row.files.map((f:any)=>f.path));pending=rows.flatMap(row=>row.dependencies);}};
    if(action==='policy'){
     if(principal.role!=='admin'||(p.owner_id&&principal.owner!==p.owner_id))throw new Problem(403,'policy_owner','Only the workspace owner can manage review policy');
     if(request.method==='GET'){const [row]=await sql`SELECT rules,updated_at FROM weave_review_policy WHERE project=${pid}`;return json(row??{rules:[]});}
     if(request.method==='POST'){const rules=parseRules((await body(request)).rules);await sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'weave-publish:'+pid},0))`;const [pending]=await tx`SELECT id FROM weave_publications WHERE project=${pid} AND state='preparing' LIMIT 1`;if(pending)throw new Problem(409,'publication_pending','Complete or cancel the in-flight publication before changing policy');await tx`INSERT INTO weave_review_policy(project,rules) VALUES(${pid},${tx.json(rules)}) ON CONFLICT(project) DO UPDATE SET rules=EXCLUDED.rules,updated_at=clock_timestamp()`;});return json({rules});}
    }
    if(action==='tokens'){
     if(!principal.owner||p.owner_id!==principal.owner)throw new Problem(403,'token_owner','Only the workspace owner may manage agent credentials');
     const tokenView=(r:any)=>({id:r.id,label:r.label,role:r.role,expiresAt:r.expires_at,revokedAt:r.revoked_at,paths:r.paths??null});
     if(request.method==='GET')return json({tokens:(await sql`SELECT * FROM weave_tokens WHERE project=${pid} ORDER BY created_at DESC LIMIT 100`).map(tokenView)});
     if(request.method==='POST'&&parts[5]==='revoke'){await sql`UPDATE weave_tokens SET revoked_at=now() WHERE project=${pid} AND id=${id(parts[4])}`;return json({revoked:true});}
     if(request.method==='POST'&&!parts[4]){const input=await body(request);const label=text(input.label,80);const paths=parseScopes(input.paths);if(!['agent','reader','reviewer'].includes(input.role)||!Number.isInteger(input.days)||input.days<1||input.days>30)throw new Problem(400,'token_options','Choose agent, reader or reviewer and a lifetime of 1–30 days');
      const token='sq_'+randomBytes(32).toString('base64url');const tokenId='tok_'+randomBytes(12).toString('hex');const expires=new Date(Date.now()+input.days*86400000);
      const made=await sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'tokens:'+pid},0))`;const [{count}]=await tx`SELECT count(*) FROM weave_tokens WHERE project=${pid} AND revoked_at IS NULL AND expires_at>now()`;if(Number(count)>=32)throw new Problem(429,'token_cap','At most 32 active credentials per workspace');const [row]=await tx`INSERT INTO weave_tokens(id,project,token_hash,label,role,expires_at,paths) VALUES(${tokenId},${pid},${sha256(token)},${label},${input.role},${expires},${paths}) RETURNING *`;return row;});
      return json({...tokenView(made),token},201);
     }
    }
    if(action==='rpc'&&request.method==='POST'){unrestricted();if(!config.source||p.storage!=='source')throw new Problem(409,'source_storage','Raw RPC requires source storage');const input=await body(request);if(input.op==='authorize')return json({project:pid,expiresAt:Math.min(Date.now()+30000,principal.expiresAt??Infinity)});return await config.source.rpc(pid,input);}
    if(action==='objects'&&request.method==='POST'){unrestricted();
     const input=await body(request);const objects=input.objects;
     if(!Array.isArray(objects)||!objects.length||objects.length>32||objects.some(o=>!['commit','tree','blob'].includes(o?.type)||typeof o.oid!=='string'||!/^[a-f0-9]{40}$/.test(o.oid)))throw new Problem(400,'object_batch','Request 1–32 immutable Git objects');
     const result=[];let bytes=0;const seen=new Set<string>();
     for(const object of objects){const key=object.type+':'+object.oid;if(seen.has(key))continue;seen.add(key);const value=object.type==='commit'?await repo.commit(object.oid):object.type==='tree'?await repo.tree(object.oid):await (async()=>{const blob=await repo.blob(object.oid);if(blob.length>512*1024)throw new Problem(413,'object_bytes','Large files must use the raw blob endpoint');return Buffer.from(blob).toString('base64');})();if(value===null)throw new Problem(404,'object_missing','Object not found');bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>1024*1024)throw new Problem(413,'object_bytes','Object batch exceeds 1 MiB; request fewer objects');result.push({...object,value});}
     return json({objects:result});
    }
    if(action==='git'){unrestricted();
     const suffix='/'+parts.slice(4).join('/')+url.search;
     if(!((request.method==='GET'&&(suffix==='/info/refs?service=git-upload-pack'||(p.storage==='source'&&(/^\/(?:HEAD|info\/refs|objects\/)/).test(suffix))))||(request.method==='POST'&&suffix==='/git-upload-pack')))throw new Problem(403,'read_only_git','The Git gateway is read-only; propose writes through the changes API');
     if(request.method==='POST')request=await gitBody(request);
     const upstream=await repo.git(request,suffix);return new Response(upstream.body,{status:upstream.status,headers:{'content-type':upstream.headers.get('content-type')??'application/octet-stream','cache-control':'private, no-store',...Object.fromEntries(['content-length','content-range','accept-ranges'].filter(k=>upstream.headers.has(k)).map(k=>[k,upstream.headers.get(k)!]))}});
    }
    if(action==='source'&&request.method==='POST'){unrestricted();requireRole(['admin']);if(!config.source||p.storage!=='source')throw new Problem(409,'source_storage','Workspace does not use source storage');if(parts[4]==='snapshot'&&parts[5]==='part')return json(await config.source.snapshots.upload(pid,parts[6]??'',request));if(parts[4]==='blob')return json(await config.source.uploadBlob(pid,parts[5]??'',request));const input=await body(request);if(parts[4]==='snapshot'){if(parts[5]==='prepare')return json(await config.source.snapshots.prepare(p,input));if(parts[5]==='index')return json(await config.source.snapshots.index(pid,input.oids));if(parts[5]==='complete')return json(await config.source.snapshots.complete(pid));}if(parts[4]?.startsWith('bridge-')){await nativeJobCredential(config,principal,pid,input.lease);if(parts[4]==='bridge-prepare')return json(await config.source.exportPrepare({...p,main_ref:typeof input.defaultBranch==='string'?'refs/heads/'+input.defaultBranch:p.main_ref},input.refs));if(parts[4]==='bridge-confirm')return json(await config.source.exportConfirm({...p,main_ref:typeof input.defaultBranch==='string'?'refs/heads/'+input.defaultBranch:p.main_ref},input.refs));if(parts[4]==='bridge-index')return json(await config.source.exportIndex(p,input.manifest,input.oids));}if(parts[4]==='credentials'){const job=await nativeJobCredential(config,principal,pid,input.lease);return json(await githubService(config,{...principal,owner:job.owner_id}).credentials(job.import_id));}if(parts[4]==='derive')return json(await config.source.derive(pid,input.kind,input.version,input.changesets));if(parts[4]==='missing')return json(await config.source.missing(pid,input.oids));if(parts[4]==='objects')return json(await config.source.upload(pid,input.objects));if(parts[4]==='changesets')return json(await config.source.sealBatch(pid,input.commits));if(parts[4]==='finish')return json(await config.source.finish(pid,input.refs,input.defaultBranch,input.gitBridgeLimited===true));}
    if(action==='source'&&request.method==='GET'){unrestricted();requireRole(['admin']);if(!config.source||p.storage!=='source')throw new Problem(409,'source_storage','Workspace does not use source storage');return json(await config.source.status(pid));}
    if(action==='changesets'&&request.method==='GET'){unrestricted();if(!config.source||p.storage!=='source')throw new Problem(409,'source_storage','Workspace does not use source storage');return json(await config.source.changeset(pid,parts[4]??''));}
    const changes=changeService(config,p,principal);
    const sourcePaths=p.storage==='source'&&config.source?config.source.pathReader(pid):undefined;
    const metadata=metadataService(sql,pid,repo,sourcePaths?{latestPath:sourcePaths.latest,commit:sourcePaths.commit,renameCandidates:(oid,parent,path)=>config.source!.renameCandidates(pid,oid,parent,path)}:undefined);
    if(action==='index'&&request.method==='POST'){unrestricted();requireRole(['admin']);const input=await body(request);if(parts[4]==='commits')return json(await metadata.indexCommits(input.ref,input.commits));if(parts.length===4)return json(await metadata.index(input.ref,input.limit??64));}
    if(action==='index'&&request.method==='GET'){unrestricted();requireRole(['admin']);return json(await metadata.indexStatus(url.searchParams.get('ref')??''));}
    if(['ancestry','merge-base','diff','bisect'].includes(action)&&request.method==='POST'){
     const input=await body(request);
     if(action!=='diff')unrestricted();else if(principal.paths){if(!input.path)unrestricted();validPath(input.path);authorizePaths(principal,[input.path]);}
     if(action==='ancestry')return json(await metadata.ancestry(input.ancestor,input.descendant));
     if(action==='merge-base')return json(await metadata.mergeBase(input.left,input.right));
     if(action==='diff')return json(await metadata.diff(input.from,input.to,input.path));
     return json(await metadata.bisect(input.good,input.bad));
    }
    if(action==='search'&&request.method==='GET'){const ref=url.searchParams.get('ref')??await repo.head();if(!ref)return json({matches:[],next:null});const path=url.searchParams.get('path')??'';if(principal.paths){if(!path)unrestricted();authorizePaths(principal,[path]);}return json(await metadata.search(ref,url.searchParams.get('query')??'',path,url.searchParams.get('cursor')??undefined));}
    if(['path-history','blame','commit'].includes(action)&&request.method==='GET'){
     const ref=url.searchParams.get('ref')??await repo.head();if(!ref)throw new Problem(404,'commit_missing','Repository is empty');
     if(action==='commit'){unrestricted();return json(await metadata.commit(ref));}
     const path=url.searchParams.get('path')??'';authorizePaths(principal,[path]);
     if(action==='blame')return json(await metadata.blame(ref,path));const history=p.storage==='source'&&config.source?await config.source.history(pid,ref,path,Number(url.searchParams.get('limit')??20),url.searchParams.get('cursor')??undefined):await metadata.history(ref,path,Number(url.searchParams.get('limit')??20));return json(principal.paths?{...history,commits:history.commits.map(({oid,parents})=>({oid,parents}))}:history);
    }
    if(action==='rebase-series'&&request.method==='POST'){unrestricted();requireRole(['admin','agent']);const input=await body(request);if(input.resolutions&&typeof input.resolutions==='object')for(const value of Object.values(input.resolutions))patches(value);return json(await rebaseSeries(config,pid,principal,input,changes,metadata));}
    if(action==='rebase-plan'&&request.method==='POST'){unrestricted();requireRole(['admin','agent']);const input=await body(request);return json(await metadata.rebaseWorkspace(input.base,input.onto,patches(input.files),patches(input.resolutions??[])));}
    if(action==='rebase'&&request.method==='POST'){unrestricted();requireRole(['admin','agent']);
     const input=await body(request),changeId=id(input.id),note=input.note===undefined?'Reapply this commit onto an explicit immutable base':text(input.note,4000),resolutions=patches(input.resolutions??[]);
     const plan=await metadata.rebase(input.commit,input.onto,input.parent,resolutions);
     return json(await changes.propose({id:changeId,title:'Rebase '+input.commit.slice(0,12),intent:note,context:{rebase:{commit:input.commit,onto:input.onto,parent:plan.parent,base:plan.base,resolutionsHash:sha256(JSON.stringify(resolutions))}},dependencies:[],base:input.onto,files:plan.files}),201);
    }
    if(action==='revert'&&request.method==='POST'){unrestricted();
     requireRole(['admin','agent']);const input=await body(request);const head=await repo.head();if(!head)throw new Problem(404,'commit_missing','Repository is empty');
     return json(await changes.propose({id:id(input.id),title:'Revert '+text(input.commit,40),intent:input.note?text(input.note,4000):'Revert this commit through review',context:{reverts:input.commit},dependencies:[],base:head,files:await metadata.revert(input.commit,head)}),201);
    }
    if(action==='changes'&&request.method==='GET'&&!parts[4]){
     const rows=await sql`SELECT * FROM weave_changes WHERE project=${pid} AND status<>'preparing' ORDER BY created_at DESC LIMIT 200`;
     const overlaps=await sql`SELECT a.change_id AS left_id,b.change_id AS right_id,a.path FROM weave_paths a JOIN weave_paths b ON a.project=b.project AND a.path=b.path AND a.change_id<b.change_id JOIN weave_changes ca ON ca.project=a.project AND ca.id=a.change_id JOIN weave_changes cb ON cb.project=b.project AND cb.id=b.change_id WHERE a.project=${pid} AND ca.status IN ('proposed','approved') AND cb.status IN ('proposed','approved') LIMIT 200`;
     let visible=rows.filter(c=>c.files.every((f:any)=>canPath(principal,f.path)));if(principal.paths){let count;do{count=visible.length;const allowed=new Set(visible.map(c=>c.id));visible=visible.filter(c=>c.dependencies.every((dependency:string)=>allowed.has(dependency)));}while(visible.length!==count);}const visibleIds=new Set(visible.map(c=>c.id));return json({changes:visible.map(changeView),overlaps:overlaps.filter(o=>visibleIds.has(o.left_id)&&visibleIds.has(o.right_id))});
    }
    if(action==='changes'&&request.method==='POST'&&!parts[4]){
     requireRole(['admin','agent']);const b=await body(request);const deps=b.dependencies??[];if(!Array.isArray(deps)||deps.length>32||new Set(deps).size!==deps.length)throw new Problem(400,'dependencies','At most 32 unique dependencies');deps.forEach(id);await checkChanges(deps);
     const context=b.context??{};if(!context||typeof context!=='object'||Array.isArray(context)||Buffer.byteLength(JSON.stringify(context))>32768)throw new Problem(400,'context','Context must be an object up to 32 KiB');
     if(b.base!==undefined&&(typeof b.base!=='string'||!/^[a-f0-9]{40}$/.test(b.base)))throw new Problem(400,'invalid_ref','Base must be an immutable commit');
     return json(await changes.propose({id:id(b.id),title:text(b.title),intent:text(b.intent,4000),context,dependencies:deps,base:b.base,files:(()=>{const files=patches(b.files);authorizePaths(principal,files.map(f=>f.path));return files;})()}),201);
    }
    if(action==='changes'&&parts[4]&&request.method==='GET'){await checkChanges([id(parts[4])]);return json(await changes.details(id(parts[4])));}
    if(action==='changes'&&parts[5]==='revise'&&request.method==='POST'){requireRole(['admin','agent']);await checkChanges([id(parts[4])]);const b=await body(request);authorizePaths(principal,patches(b.files).map(f=>f.path));return json(await changes.revise(id(parts[4]),{id:id(b.id),files:patches(b.files),note:text(b.note,4000)}),201);}
    if(action==='changes'&&parts[5]==='review'&&request.method==='POST'){
     requireRole(['admin','reviewer']);await checkChanges([id(parts[4])]);const b=await body(request);if(!['approved','rejected','proposed'].includes(b.decision))throw new Problem(400,'decision','Choose approved, rejected or proposed');return json(await changes.review(id(parts[4]),b.decision,text(b.note??'',4000,true)));
    }
    if((action==='preview'||action==='publish')&&request.method==='POST'){
     if(action==='publish')requireRole(['admin','reviewer']);const b=await body(request);if(!Array.isArray(b.changes)||!b.changes.length||b.changes.length>64||new Set(b.changes).size!==b.changes.length)throw new Problem(400,'batch','Select 1–64 unique changes');b.changes.forEach(id);await checkChanges(b.changes);
     if(action==='preview'){const plan=await changes.preview(b.changes);return json({...plan,files:plan.files.map(f=>({path:f.path,bytes:'oid' in f?f.bytes:Buffer.byteLength(f.content??''),deleted:'content' in f&&f.content===null}))});}
     return json(await changes.publish({id:id(b.id),changes:b.changes,expectedHead:b.expectedHead}),201);
    }
    if(action==='events'&&request.method==='GET'){unrestricted();const after=Number(url.searchParams.get('after')??0);if(!Number.isSafeInteger(after)||after<0)throw new Problem(400,'cursor','Invalid cursor');return json({events:await sql`SELECT * FROM weave_events WHERE project=${pid} AND seq>${after} ORDER BY seq LIMIT 200`});}
    if(action==='publications'&&parts[5]==='abort'&&request.method==='POST'){unrestricted();requireRole(['admin','reviewer']);const b=await body(request);return json(await changes.abort(id(parts[4]),text(b.expectedHead,40),text(b.note,4000)));}
    if(action==='publications'&&request.method==='GET'){unrestricted();return json({publications:(await sql`SELECT * FROM weave_publications WHERE project=${pid} ORDER BY created_at DESC LIMIT 100`).map(publicationView)});}
    if(!action&&request.method==='GET')return json({...projectView(p),head:await repo.head()});
    if(action==='blob'&&request.method==='GET'){
     const path=url.searchParams.get('path')??'';validPath(path);authorizePaths(principal,[path]);const ref=url.searchParams.get('ref')??await repo.head();if(!ref)throw new Problem(404,'file_missing','Repository is empty');const entry=await g.entry(ref,path);if(!entry||entry.type!=='blob'||!['100644','100755'].includes(entry.mode))throw new Problem(404,'file_missing','Regular file not found');const bytes=await repo.blob(entry.oid);if(bytes.length>32*1024*1024)throw new Problem(413,'blob_limit','Git blob exceeds the 32 MiB read limit');return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),'x-git-oid':entry.oid,'x-git-mode':entry.mode,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':'attachment'}});
    }
    if(action==='file'&&request.method==='GET'){const ref=url.searchParams.get('ref')??await repo.head()??p.head;const path=url.searchParams.get('path')??'';validPath(path);authorizePaths(principal,[path]);if(!ref)throw new Problem(404,'file_missing','The repository is empty');const content=await g.file(ref,path);if(content===null)throw new Problem(404,'file_missing','File not found');const entry=await g.entry(ref,path);return json({path,ref,content,oid:entry!.oid,mode:entry!.mode});}
    if(action==='tree'&&request.method==='GET'){const ref=url.searchParams.get('ref')??await repo.head()??p.head;const path=url.searchParams.get('path');if(path&&principal.paths&&!canPath(principal,path)&&!principal.paths.some(prefix=>containsPath(path,prefix)))throw new Problem(403,'path_scope','This credential cannot access that path');if(!ref)return json({ref:null,path:'',entries:[]});const commit=await g.commit(ref);if(!commit)throw new Problem(404,'commit_missing','Commit not found');const entry=path?await g.entry(ref,path):null;if(path&&entry?.type!=='tree')throw new Problem(404,'tree_missing','Directory not found');return json({ref,path:path??'',entries:(await g.tree(entry?.oid??commit.tree)).filter(e=>{const item=path?path+'/'+e.name:e.name;return canPath(principal,item)||e.type==='tree'&&principal.paths?.some(prefix=>containsPath(item,prefix));})});}
   }
   throw new Problem(404,'not_found','API route not found');
  }catch(e){if(e instanceof Problem)return json({error:e.code,message:e.message,details:e.details},e.status);console.error('request failed',e instanceof Error?e.message:'unknown');return json({error:'internal_error',message:'Request failed; retry with the same operation ID.'},500);}
 };
}

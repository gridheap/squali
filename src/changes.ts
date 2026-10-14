import {enforceReviewPolicy} from './permissions.ts';
import {diff3Merge} from 'node-diff3';
import {GitSession,sha256,blobId} from './git.ts';
import {Problem,ZERO} from './types.ts';
import type {Config,Patch,Principal} from './types.ts';
export type FileDelta={path:string;before:string|null;after:string|null;mode:string;beforeMode:string|null};
export function changeView(c:any){return {id:c.id,project:c.project,title:c.title,intent:c.intent,context:c.context,dependencies:c.dependencies,base:c.base,oid:c.oid,author:c.author,status:c.status,reviewer:c.reviewer,reviewNote:c.review_note,publication:c.publication,createdAt:c.created_at,files:c.files};}
export function publicationView(p:any){return {id:p.id,base:p.base,oid:p.oid,changes:p.changes,state:p.state,cancellationHead:p.metrics?.cancellation?.oid??null,metrics:p.metrics?{objects:p.metrics.objects,bytes:p.metrics.bytes,changes:p.metrics.changes}:null};}
export function changeService(config:Config,p:any,principal:Principal){
 const {sql,artifacts}=config;const storage=artifacts.repo(p.artifact);const repo={...storage,head:(ref?:string)=>storage.head(ref??p.main_ref)};const g=new GitSession(repo);const pid=p.id;
 const event=async(tx:any,kind:string,data:unknown,actor=principal.id)=>tx`INSERT INTO weave_events(project,kind,actor,data) VALUES(${pid},${kind},${actor},${tx.json(data)})`;
 const get=async(cid:string)=>{const [c]=await sql`SELECT * FROM weave_changes WHERE project=${pid} AND id=${cid}`;if(!c)throw new Problem(404,'change_missing','Change not found');return c;};
 async function propose(input:{id:string;title:string;intent:string;context:Record<string,unknown>;dependencies:string[];base?:string;files:Patch[]}){
  const hash=sha256(JSON.stringify(input));
  const [existing]=await sql`SELECT * FROM weave_changes WHERE project=${pid} AND id=${input.id}`;
  if(existing){
   if(existing.request_hash!==hash||existing.author!==principal.id)throw new Problem(409,'idempotency_mismatch','Change ID already used with different input or author');
   if(existing.status!=='preparing')return changeView(existing);
  }
  const base=existing?.base??input.base??await repo.head()??ZERO;
  if(base!==ZERO)await g.commit(base).then(c=>{if(!c)throw new Problem(404,'commit_missing','Base commit not found');});
  if(input.dependencies.includes(input.id))throw new Problem(400,'dependency_cycle','A change cannot depend on itself');
  await sql.begin(async tx=>{
   for(const dep of input.dependencies){const [c]=await tx`SELECT status FROM weave_changes WHERE project=${pid} AND id=${dep}`;if(!c||['rejected','preparing'].includes(c.status))throw new Problem(409,'dependency_missing','Dependencies must already be available');}
   await tx`INSERT INTO weave_changes(project,id,request_hash,author,title,intent,context,dependencies,base,files) VALUES(${pid},${input.id},${hash},${principal.id},${input.title},${input.intent},${tx.json(JSON.parse(JSON.stringify(input.context)))},${input.dependencies},${base},'[]') ON CONFLICT DO NOTHING`;
  });
  const [c]=await sql`SELECT * FROM weave_changes WHERE project=${pid} AND id=${input.id}`;
   if(c.request_hash!==hash||c.author!==principal.id)throw new Problem(409,'idempotency_mismatch','Change ID already used with different input or author');
   if(c.status!=='preparing')return changeView(c);
   const built=await g.build(c.base===ZERO?null:c.base,input.files,`${input.title}\n\nSquali-Change: ${input.id}\nIntent: ${input.intent}`,principal.id,Math.floor(new Date(c.created_at).getTime()/1000));
   const ref=`refs/heads/weave/${input.id}`;if(await repo.head(ref)!==built.oid)await repo.push(ref,null,built.oid,built.pack);
   const files:FileDelta[]=[];for(const f of input.files){const before=await g.entry(c.base,f.path),after=await g.entry(built.oid,f.path);if(before?.oid===after?.oid&&before?.mode===after?.mode)continue;files.push({path:f.path,before:before?.oid??null,after:after?.oid??null,mode:after?.mode??before?.mode??'100644',beforeMode:before?.mode??null});}
   return sql.begin(async tx=>{
   const [current]=await tx`SELECT * FROM weave_changes WHERE project=${pid} AND id=${input.id} FOR UPDATE`;
   if(current.status!=='preparing')return changeView(current);
   const [ready]=await tx`UPDATE weave_changes SET oid=${built.oid},files=${tx.json(files)},status='proposed' WHERE project=${pid} AND id=${input.id} RETURNING *`;
   for(const f of files)await tx`INSERT INTO weave_paths(project,change_id,path) VALUES(${pid},${input.id},${f.path}) ON CONFLICT DO NOTHING`;
   await event(tx,'change.proposed',{id:c.id,title:c.title,objects:built.objects,bytes:built.bytes});return changeView(ready);
  });
 }
 async function details(cid:string){const c=await get(cid);const diff=[];for(const f of c.files as FileDelta[])diff.push({path:f.path,before:await g.file(c.base,f.path),after:await g.file(c.oid,f.path)});return {...changeView(c),diff};}
 async function review(cid:string,decision:string,note:string){
  return sql.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`weave-publish:${pid}`},0))`;const [c]=await tx`SELECT * FROM weave_changes WHERE project=${pid} AND id=${cid} FOR UPDATE`;
   if(!c)throw new Problem(404,'change_missing','Change not found');if(!['proposed','approved','rejected'].includes(c.status))throw new Problem(409,'review_state','This change cannot be reviewed');
   const [pending]=await tx`SELECT id FROM weave_publications WHERE project=${pid} AND state='preparing' LIMIT 1`;if(pending)throw new Problem(409,'publication_pending','Recover the pending publication before changing approvals');
   if(decision==='approved')await enforceReviewPolicy(tx,pid,[c],principal.id);
   const [r]=await tx`UPDATE weave_changes SET status=${decision},reviewer=${principal.id},review_note=${note},reviewed_at=now() WHERE project=${pid} AND id=${cid} RETURNING *`;await event(tx,'change.'+decision,{id:cid,note,oid:c.oid});return changeView(r);
  });
 }
 async function preview(ids:string[],database:any=sql){
  const head=await repo.head()??ZERO;
  const rows=await database`SELECT * FROM weave_changes WHERE project=${pid} AND id=ANY(${ids})`;const byId=new Map<string,any>(rows.map((c:any)=>[c.id,c]));
  if(rows.length!==ids.length)throw new Problem(404,'change_missing','One or more changes do not exist');
  const ordered:any[]=[];const visited=new Set<string>();const visiting=new Set<string>();
  const visit=async(cid:string)=>{if(visited.has(cid))return;if(visiting.has(cid))throw new Problem(409,'dependency_cycle','Dependency cycle');visiting.add(cid);const c=byId.get(cid)!;for(const dep of c.dependencies){if(byId.has(dep))await visit(dep);else {const [d]=await database`SELECT status FROM weave_changes WHERE project=${pid} AND id=${dep}`;if(d?.status!=='landed')throw new Problem(409,'dependency_unlanded',`Dependency ${dep} must land first`);}}visited.add(cid);visiting.delete(cid);ordered.push(c);};for(const cid of ids)await visit(cid);
  const conflicts:any[]=[];const files=new Map<string,Patch>();const applied=new Map<string,string|null>();let mergedLines=0;let sourceBytes=0;let touchedFiles=0;
  for(const c of ordered){for(const f of c.files as FileDelta[]){const currentEntry=await g.entry(head,f.path);const current=applied.has(f.path)?applied.get(f.path)!:currentEntry?.oid??null;const currentMode=files.has(f.path)?files.get(f.path)!.mode:currentEntry?.mode;
   if(++touchedFiles>256)throw new Problem(413,'batch_file_limit','A batch may touch at most 256 file revisions');
   if(currentEntry&&(currentEntry.type!=='blob'||!['100644','100755'].includes(currentEntry.mode))){conflicts.push({change:c.id,path:f.path,reason:'Target is no longer a regular file'});continue;}
   let content=f.after===null?null:Buffer.from(await g.blob(f.after)).toString('utf8');
   if(current!==f.before&&current!==f.after){
    const ours=files.has(f.path)?files.get(f.path)!.content:current?Buffer.from(await g.blob(current)).toString('utf8'):null;
    const base=f.before?Buffer.from(await g.blob(f.before)).toString('utf8'):null;
    let merged:string|null=null;
    if(ours!==null&&base!==null&&content!==null&&![ours,base,content].some(s=>s.includes('\0'))){
     const a=ours.split('\n'),o=base.split('\n'),b=content.split('\n');mergedLines+=a.length+o.length+b.length;
     if(Math.max(a.length,o.length,b.length)<=2000&&mergedLines<=12000){
      const regions=diff3Merge(a,o,b,{excludeFalseConflicts:true});const result:string[]=[];let conflict=false;
      for(const region of regions){if(region.ok)result.push(...region.ok);else if(region.conflict){const r=region.conflict;
       if(r.a.length===r.o.length&&r.b.length===r.o.length){for(let i=0;i<r.o.length;i++){if(r.a[i]===r.b[i]||r.b[i]===r.o[i])result.push(r.a[i]);else if(r.a[i]===r.o[i])result.push(r.b[i]);else conflict=true;}}
       else conflict=true;
      }}
      if(!conflict)merged=result.join('\n');
     }
    }
    if(merged===null){conflicts.push({change:c.id,path:f.path,base:f.before,current,incoming:f.after,reason:'Overlapping edits, deletion, or text merge limit; create a reviewed revision'});continue;}
    content=merged;
   }
   sourceBytes+=Buffer.byteLength(content??'');if(sourceBytes>2*1024*1024)throw new Problem(413,'batch_size','A publication may contain at most 2 MiB of changed text');
   const mode=f.mode===f.beforeMode&&currentMode?currentMode:f.mode;
   if(content===null&&currentMode&&f.beforeMode&&currentMode!==f.beforeMode){conflicts.push({change:c.id,path:f.path,reason:'Deletion conflicts with a file mode change'});continue;}
   files.set(f.path,{path:f.path,content,mode:mode as '100644'|'100755'});
   // A merged buffer can differ from every stored object; subsequent changes use files above.
   applied.set(f.path,content===null?null:blobId(content));

  }}
  const unapproved=ordered.filter(c=>c.status!=='approved').map(c=>c.id);
  return {head,changes:ordered.map(c=>c.id),parents:ordered.map(c=>c.oid),ready:conflicts.length===0&&unapproved.length===0,conflicts,unapproved,files:[...files.values()]};
 }
 async function publish(input:{id:string;changes:string[];expectedHead?:string}){
  const hash=sha256(JSON.stringify(input));
  const [existing]=await sql`SELECT * FROM weave_publications WHERE project=${pid} AND id=${input.id}`;
  const validate=(saved:any,checkCancellation=true)=>{if(saved&&saved.request_hash!==hash)throw new Problem(409,'idempotency_mismatch','Publication ID already used with different input');if(checkCancellation&&saved?.state==='preparing'&&saved?.metrics?.cancellation)throw new Problem(409,'cancellation_pending','Finish cancelling this publication before publishing again');if(saved?.state==='aborted')throw new Problem(409,'publication_aborted','This publication was cancelled; use a new ID');};
  validate(existing,false);if(existing?.state==='published')return publicationView(existing);
  const finalize=()=>sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`weave-publish:${pid}`},0))`;
   const [current]=await tx`SELECT * FROM weave_publications WHERE project=${pid} AND id=${input.id}`;
   if(current.state==='published')return publicationView(current);if(current.state!=='preparing')throw new Problem(409,'publication_state','Publication changed; reconcile its journal');
   const [done]=await tx`UPDATE weave_publications SET state='published',metrics=metrics-'active' WHERE project=${pid} AND id=${input.id} RETURNING *`;
   await tx`UPDATE weave_projects SET head=${done.oid} WHERE id=${pid}`;await tx`UPDATE weave_changes SET status='landed',publication=${input.id} WHERE project=${pid} AND id=ANY(${done.changes})`;await event(tx,'batch.published',{id:input.id,oid:done.oid,changes:done.changes},done.actor);return publicationView(done);
  });
  if(existing?.oid&&await repo.head()===existing.oid)return finalize();
  validate(existing);
  const plan=await preview(input.changes);
  if(input.expectedHead&&input.expectedHead!==plan.head)throw new Problem(409,'head_moved','Main changed since preview; refresh before publishing');
  if(!plan.ready)throw new Problem(409,'not_ready','Batch requires approval or conflict resolution',{conflicts:plan.conflicts,unapproved:plan.unapproved});
  const active=crypto.randomUUID();
  const saved=await sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`weave-publish:${pid}`},0))`;
   const [other]=await tx`SELECT id FROM weave_publications WHERE project=${pid} AND state='preparing' AND id<>${input.id} LIMIT 1`;if(other)throw new Problem(409,'publication_pending','Retry the pending publication first',{id:other.id});
   const [current]=await tx`SELECT * FROM weave_publications WHERE project=${pid} AND id=${input.id}`;validate(current);if(current?.state==='published')return current;
   const rows=await tx`SELECT * FROM weave_changes WHERE project=${pid} AND id=ANY(${plan.changes})`;await enforceReviewPolicy(tx,pid,rows);if(rows.length!==plan.changes.length||rows.some(c=>c.status!=='approved'))throw new Problem(409,'review_changed','Approval changed since preview; refresh the batch');
   if(current&&current.base!==plan.head)throw new Problem(409,'recovery_required','Main moved while a publication was pending. Inspect Git before recovering.',{publication:input.id,base:current.base,head:plan.head});
   if(current){const [claimed]=await tx`UPDATE weave_publications SET metrics=COALESCE(metrics,'{}'::jsonb)||${tx.json({active})} WHERE project=${pid} AND id=${input.id} RETURNING *`;return claimed;}
   const [created]=await tx`INSERT INTO weave_publications(project,id,request_hash,base,changes,actor,metrics) VALUES(${pid},${input.id},${hash},${plan.head},${plan.changes},${principal.id},${tx.json({active,parents:plan.parents})}) RETURNING *`;return created;
  });
  if(saved.state==='published')return publicationView(saved);
  try{
   const built=await g.build(plan.head===ZERO?null:plan.head,plan.files,`Squali batch ${input.id}\n\nChanges: ${plan.changes.join(', ')}`,saved.actor,Math.floor(new Date(saved.created_at).getTime()/1000),saved.metrics?.parents??[]);
   if(saved.oid&&saved.oid!==built.oid)throw new Problem(409,'recovery_required','The recovered commit differs from the publication journal');
   const written=await sql`UPDATE weave_publications SET oid=${built.oid},metrics=${sql.json({active,parents:saved.metrics?.parents??[],objects:built.objects,bytes:built.bytes,changes:plan.changes.length})} WHERE project=${pid} AND id=${input.id} AND state='preparing' AND NOT(COALESCE(metrics,'{}'::jsonb)?'cancellation') AND (oid IS NULL OR oid=${built.oid}) RETURNING id`;
   if(!written.length){const [current]=await sql`SELECT * FROM weave_publications WHERE project=${pid} AND id=${input.id}`;validate(current);if(current.state==='published')return publicationView(current);throw new Problem(409,'publication_state','Publication changed before the push');}
   try{await repo.push(p.main_ref??'refs/heads/main',plan.head===ZERO?null:plan.head,built.oid,built.pack);}
   catch(error){if(!(error instanceof Problem&&error.code==='head_moved')||await repo.head()!==built.oid)throw error;}
   return await finalize();
  }finally{
   await sql`UPDATE weave_publications SET metrics=metrics-'active' WHERE project=${pid} AND id=${input.id} AND metrics->>'active'=${active}`;
  }
 }
 async function revise(cid:string,input:{id:string;files:Patch[];note:string}){
  const c=await get(cid);if(c.author!==principal.id&&principal.role!=='admin')throw new Problem(403,'author','Only the author or admin may revise a change');
  if(c.status==='landed')throw new Problem(409,'revision_state','A landed change needs a new follow-up change');
  const [existing]=await sql`SELECT base FROM weave_changes WHERE project=${pid} AND id=${input.id}`;
  const next=await propose({id:input.id,title:c.title,intent:c.intent,context:{...c.context,supersedes:cid,resolution:input.note},dependencies:c.dependencies,base:existing?.base??(await repo.head())!,files:input.files});
  return sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`weave-publish:${pid}`},0))`;
   const [current]=await tx`SELECT status FROM weave_changes WHERE project=${pid} AND id=${cid}`;
   const [pending]=await tx`SELECT id FROM weave_publications WHERE project=${pid} AND state='preparing' LIMIT 1`;
   if(pending||current.status==='landed')throw new Problem(409,'revision_state','The original change is publishing or landed. The new proposal is retained; reconcile before superseding it.');
   if(current.status!=='superseded'){await tx`UPDATE weave_changes SET status='superseded' WHERE project=${pid} AND id=${cid}`;await event(tx,'change.revised',{id:cid,replacement:input.id});}return next;
  });
 }
 async function abort(publicationId:string,expectedHead:string,note:string){
  const [existing]=await sql`SELECT * FROM weave_publications WHERE project=${pid} AND id=${publicationId}`;
  if(!existing)throw new Problem(404,'publication_missing','Publication not found');
  if(existing.state==='aborted')return publicationView(existing);
  const alreadyPublished=()=>new Problem(409,'already_published','Git already accepted this batch; retry the original publication to finalize it');
  if(existing.state!=='preparing')throw alreadyPublished();
  const finalizeCancellation=()=>sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`weave-publish:${pid}`},0))`;
   const [current]=await tx`SELECT * FROM weave_publications WHERE project=${pid} AND id=${publicationId}`;
   if(current.state==='aborted')return publicationView(current);
   if(current.state!=='preparing')throw alreadyPublished();
   const cancellation=current.metrics.cancellation;
   const [aborted]=await tx`UPDATE weave_publications SET state='aborted',metrics=metrics-'active' WHERE project=${pid} AND id=${publicationId} RETURNING *`;
   await tx`UPDATE weave_projects SET head=${cancellation.oid} WHERE id=${pid}`;
   await event(tx,'batch.aborted',{id:publicationId,note:cancellation.note,oid:cancellation.oid},cancellation.actor);
   return publicationView(aborted);
  });
  const head=await repo.head()??ZERO;
  if(head===existing.oid)throw alreadyPublished();
  if(existing.metrics?.cancellation?.oid===head)return finalizeCancellation();
  if(expectedHead!==head||head!==existing.base)throw new Problem(409,'recovery_required','The head has moved. Reconcile Git history before cancelling.');
  const saved=await sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`weave-publish:${pid}`},0))`;
   const [current]=await tx`SELECT * FROM weave_publications WHERE project=${pid} AND id=${publicationId}`;
   if(current.state==='aborted')return current;
   if(current.state!=='preparing')throw alreadyPublished();
   if(current.metrics?.cancellation)return current;
   const cancellation={actor:principal.id,note,timestamp:Math.floor(Date.now()/1000)};
   const [claimed]=await tx`UPDATE weave_publications SET metrics=COALESCE(metrics,'{}'::jsonb)||${tx.json({cancellation})} WHERE project=${pid} AND id=${publicationId} RETURNING *`;
   return claimed;
  });
  if(saved.state==='aborted')return publicationView(saved);
  const cancellation=saved.metrics.cancellation;
  // Moving the Git ref, with an unchanged tree, invalidates every delayed push
  // from the old base. A SQL flag or elapsed lease cannot fence that transport.
  const built=await g.build(saved.base===ZERO?null:saved.base,[],`Squali cancel ${publicationId}\n\n${cancellation.note}`,cancellation.actor,cancellation.timestamp);
  if(cancellation.oid&&cancellation.oid!==built.oid)throw new Problem(409,'recovery_required','Cancellation differs from its saved commit');
  const written=await sql`UPDATE weave_publications SET metrics=jsonb_set(metrics,'{cancellation,oid}',${sql.json(built.oid)}) WHERE project=${pid} AND id=${publicationId} AND state='preparing' RETURNING id`;
  if(!written.length){const [current]=await sql`SELECT * FROM weave_publications WHERE project=${pid} AND id=${publicationId}`;if(current.state==='aborted')return publicationView(current);throw alreadyPublished();}
  try{await repo.push(p.main_ref??'refs/heads/main',saved.base===ZERO?null:saved.base,built.oid,built.pack);}
  catch(error){
   const actual=await repo.head()??ZERO;
   if(actual===saved.oid)throw alreadyPublished();
   if(actual!==built.oid)throw error;
  }
  return finalizeCancellation();
 }

 return {get,propose,details,review,preview,publish,revise,abort};
}

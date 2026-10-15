import {createHash,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {advertisedRefs,validRef} from './git-transfer.ts';
import {Problem,ZERO,type Artifacts,type Sql,type TreeEntry} from './types.ts';
import {sha256} from './git.ts';
type SourceProject={id:string;artifact:string;main_ref:string;git_bridge_limited?:boolean};
export function sourceExporter(sql:Sql,fallback:Artifacts,raw:(project:string,oid:string)=>Promise<Uint8Array>,decodeTree:(raw:Uint8Array)=>TreeEntry[]){
 async function synchronize(project:SourceProject){
  if(project.git_bridge_limited)throw new Problem(413,'git_compatibility_limit','This source repository exceeds the configured Git compatibility limit. Use source APIs, sparse checkout or the node filesystem.');
  const refs=await sql`SELECT name,oid FROM weave_source_refs WHERE project=${project.id} ORDER BY name`,identity=sha256(JSON.stringify(refs.map(r=>({name:r.name,oid:r.oid}))));
  const [saved]=await sql`SELECT manifest FROM weave_git_exports WHERE project=${project.id}`;if(saved?.manifest===identity)return;
  const lease=randomUUID();
  const [current]=await sql`INSERT INTO weave_git_exports(project,manifest,refs,lease,lease_until) VALUES(${project.id},'', '[]',${lease},now()+interval '10 minutes') ON CONFLICT(project) DO UPDATE SET lease=EXCLUDED.lease,lease_until=EXCLUDED.lease_until WHERE weave_git_exports.lease IS NULL OR weave_git_exports.lease_until<now() RETURNING *`;
  if(!current)throw new Problem(409,'export_busy','Git export is being synchronized; retry after it finishes');
  try{
   if(current.manifest===identity)return;
   const objects:any[]=[];const seen=new Set<string>();let pending=refs.map(r=>r.oid),bytes=0;
   while(pending.length){const ids=[...new Set<string>(pending)].filter(id=>!seen.has(id));pending=[];ids.forEach(id=>seen.add(id));
    for(let i=0;i<ids.length;i+=256){const rows=await sql`SELECT o.*,e.oid AS exported,b.state AS blob_state FROM weave_source_objects o LEFT JOIN weave_git_objects e ON e.project=o.project AND e.oid=o.oid LEFT JOIN weave_source_blobs b ON b.hash=o.blob WHERE o.project=${project.id} AND o.oid=ANY(${ids.slice(i,i+256)})`;
     if(rows.length!==ids.slice(i,i+256).length)throw new Problem(409,'export_incomplete','A published object is missing');
     for(const row of rows){if(row.exported)continue;bytes+=Number(row.size);objects.push(row);if(objects.length>8192||bytes>16*1024*1024)throw new Problem(413,'export_seed_required','This history needs a native Git export seed; the Worker exports at most 8,192 new objects and 16 MiB');
      if(row.kind==='blob'){if(row.blob_state!=='ready')throw new Problem(503,'source_pending','Published blob acceptance is incomplete');}
      else if(row.kind==='tree')pending.push(...decodeTree(row.raw).filter(e=>e.mode!=='160000').map(e=>e.oid));
      else if(row.kind==='commit')pending.push(...[...Buffer.from(row.raw).toString().split('\n\n')[0].matchAll(/^(?:tree|parent) ([a-f0-9]{40})$/gm)].map(m=>m[1]));
      else if(row.kind==='tag'){const target=Buffer.from(row.raw).toString().match(/^object ([a-f0-9]{40})$/m)?.[1];if(!target)throw new Problem(400,'export_tag','Invalid annotated tag');pending.push(target);}
     }
    }
   }
   await fallback.create(project.artifact,project.main_ref.replace(/^refs\/heads\//,''));const repository=fallback.repo(project.artifact);
   const existing=await advertisedRefs(await repository.git(new Request('https://squali.invalid'),'/info/refs?service=git-upload-pack'));
   const wanted=new Map(refs.map(r=>[r.name,r.oid])),previous=new Map<string,string>((current?.refs??[]).map((r:any)=>[r.name,r.oid])),known=new Map(existing.map(r=>[r.name,r.oid]));
   for(const r of existing)if(!wanted.has(r.name)||(r.oid!==wanted.get(r.name)&&r.oid!==previous.get(r.name)))throw new Problem(409,'export_changed','The Git bridge contains unexpected refs; source history was not overwritten');
   const changed=refs.filter(r=>known.get(r.name)!==r.oid).map(r=>({name:r.name,oid:r.oid,old:known.get(r.name)??ZERO}));
   if(changed.length){
    const header=Buffer.alloc(12);header.write('PACK');header.writeUInt32BE(2,4);header.writeUInt32BE(objects.length,8);const chunks=[header];
    for(const object of objects){const data=object.kind==='blob'?Buffer.from(await raw(project.id,object.oid)):Buffer.from(object.raw);let size=data.length,byte=({commit:1,tree:2,blob:3,tag:4} as Record<string,number>)[object.kind]<<4|size&15;size=Math.floor(size/16);const h=[];while(size){h.push(byte|128);byte=size&127;size=Math.floor(size/128);}h.push(byte);chunks.push(Buffer.from(h),deflateSync(data,{level:1}));}
    const payload=Buffer.concat(chunks),pack=Buffer.concat([payload,createHash('sha1').update(payload).digest()]);await repository.receive(changed,new ReadableStream({start(controller){controller.enqueue(pack);controller.close();}}));
   }
   // A late provider acknowledgement is reconciled above before any source blobs are fetched again.
   await sql.begin(async tx=>{
    const confirmed=await tx`UPDATE weave_git_exports SET manifest=${identity},refs=${tx.json(refs.map(r=>({name:r.name,oid:r.oid})))},updated_at=now() WHERE project=${project.id} AND lease=${lease} RETURNING project`;
    if(!confirmed.length)throw new Problem(409,'export_lease','Another export owns the compatibility destination; reconcile before continuing');
    if(objects.length)await tx`INSERT INTO weave_git_objects ${tx(objects.map(o=>({project:project.id,oid:o.oid})),'project','oid')} ON CONFLICT DO NOTHING`;
   });
  }finally{await sql`UPDATE weave_git_exports SET lease=NULL,lease_until=NULL WHERE project=${project.id} AND lease=${lease}`;}
 }
 async function git(project:SourceProject,request:Request,suffix:string){
  await synchronize(project);const replay=request.clone() as Request;let response=await fallback.repo(project.artifact).git(request,suffix);
  if(response.status===404){await response.body?.cancel();await sql.begin(async tx=>{const [current]=await tx`SELECT lease,lease_until FROM weave_git_exports WHERE project=${project.id} FOR UPDATE`;if(current?.lease&&new Date(current.lease_until).getTime()>Date.now())throw new Problem(409,'export_busy','Another export is repairing the compatibility destination');await tx`DELETE FROM weave_git_exports WHERE project=${project.id}`;await tx`DELETE FROM weave_git_objects WHERE project=${project.id}`;});await synchronize(project);response=await fallback.repo(project.artifact).git(replay,suffix);}
  return response;
 }
 function seedRefs(project:any,input:unknown){
  if(project.state!=='importing')throw new Problem(409,'export_seed_state','Native seeding is limited to uninitialized source imports');
  if(!Array.isArray(input)||input.length>5000||input.some(r=>typeof r?.name!=='string'||!validRef(r.name)||typeof r.oid!=='string'||!/^[a-f0-9]{40}$/.test(r.oid))||new Set(input.map(r=>r.name)).size!==input.length)throw new Problem(400,'export_refs','Supply unique immutable branch and tag refs');
  if(!validRef(project.main_ref)||input.length&&!input.some(r=>r.name===project.main_ref))throw new Problem(400,'export_default_branch','Native export requires its default branch');
  return input.map(r=>({name:r.name,oid:r.oid})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 }
 async function prepareSeed(project:any,input:unknown){
  const refs=seedRefs(project,input),manifest=sha256(JSON.stringify(refs));const [ready]=await sql`SELECT manifest FROM weave_git_exports WHERE project=${project.id}`;
  if(ready?.manifest===manifest)return {ready:true,manifest};
  await fallback.create(project.artifact,project.main_ref.replace(/^refs\/heads\//,''));const repository=fallback.repo(project.artifact),known=await advertisedRefs(await repository.git(new Request('https://squali.invalid'),'/info/refs?service=git-upload-pack'));
  const expected=new Map(refs.map(r=>[r.name,r.oid]));if(known.some(r=>expected.get(r.name)!==r.oid))throw new Problem(409,'export_changed','The native Git destination has unexpected refs');
  if(known.length===refs.length)return {ready:true,manifest};
  if(!repository.writeLease)throw new Problem(503,'export_lease','Native export credentials are unavailable');return {ready:false,manifest,pendingRefs:refs.filter(r=>!known.some(k=>k.name===r.name)).map(r=>r.name),...await repository.writeLease()};
 }
 async function confirmSeed(project:any,input:unknown){
  const refs=seedRefs(project,input),manifest=sha256(JSON.stringify(refs));const [ready]=await sql`SELECT manifest FROM weave_git_exports WHERE project=${project.id}`;if(ready?.manifest===manifest)return {manifest,confirmed:true};
  const known=await advertisedRefs(await fallback.repo(project.artifact).git(new Request('https://squali.invalid'),'/info/refs?service=git-upload-pack'));
  const expected=new Map(refs.map(r=>[r.name,r.oid]));if(known.length!==refs.length||known.some(r=>expected.get(r.name)!==r.oid))throw new Problem(409,'export_incomplete','Native Git refs are incomplete; no source state was changed');
  await sql`INSERT INTO weave_git_exports(project,manifest,refs) VALUES(${project.id},${manifest},${sql.json(refs)}) ON CONFLICT(project) DO UPDATE SET manifest=EXCLUDED.manifest,refs=EXCLUDED.refs,updated_at=now()`;return {manifest,confirmed:true};
 }
 async function seedObjects(project:any,manifest:unknown,ids:unknown){
  if(project.state!=='importing'||typeof manifest!=='string'||!Array.isArray(ids)||!ids.length||ids.length>2000||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{40}$/.test(id)))throw new Problem(400,'export_index','Index 1–2,000 immutable objects from a confirmed native import');
  const [ready]=await sql`SELECT manifest FROM weave_git_exports WHERE project=${project.id}`;if(ready?.manifest!==manifest)throw new Problem(409,'export_incomplete','Confirm the native Git refs before indexing their objects');
  const found=await sql`SELECT oid FROM weave_source_objects WHERE project=${project.id} AND oid=ANY(${ids})`;if(found.length!==new Set(ids).size)throw new Problem(409,'export_incomplete','Native index contains a missing source object');
  await sql`INSERT INTO weave_git_objects ${sql(found.map(r=>({project:project.id,oid:r.oid})),'project','oid')} ON CONFLICT DO NOTHING`;return {indexed:found.length};
 }
 return {git,prepareSeed,confirmSeed,seedObjects};
}

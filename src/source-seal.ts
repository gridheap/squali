import {createHash} from 'node:crypto';
import {Problem,type Sql,type Commit,type TreeEntry,type RawObject,type SourceDelta} from './types.ts';
import {completeGraphBatch} from './graph.ts';
import {completePathBatch} from './path-index.ts';

/** Import immutable deltas in batches; SQL work follows tree depth rather than file count. */
export async function sealSourceBatch(sql:Sql,project:string,ids:string[],decodeCommit:(id:string,raw:Uint8Array)=>Commit,decodeTree:(raw:Uint8Array)=>TreeEntry[],prepared?:{objects:RawObject[];delta:SourceDelta[]}){
 const known=new Map<string,string>((await sql`SELECT git_oid,id FROM weave_changesets WHERE project=${project} AND git_oid=ANY(${ids})`).map(r=>[r.git_oid,r.id]));
 const pending=[...new Set(ids)].filter(id=>!known.has(id)),objects=new Map<string,any>();let metadataBytes=0,treeEntries=0;
 // Only the in-process writer supplies this delta, after admitting and verifying
 // its objects. Imported/untrusted input always derives deltas from the trees.
 if(prepared){if(ids.length!==1)throw new Problem(500,'source_delta','A known delta belongs to one commit');for(const value of prepared.objects)if(value.type==='commit'||value.type==='tree'){objects.set(value.oid,{kind:value.type,raw:value.data});metadataBytes+=value.data.length;}}
 async function load(wanted:string[]){
  const missing=[...new Set(wanted)].filter(id=>!objects.has(id));
  for(let i=0;i<missing.length;i+=1000){const part=missing.slice(i,i+1000),sizes=await sql`SELECT oid,kind,size FROM weave_source_objects WHERE project=${project} AND oid=ANY(${part})`;
   if(sizes.length!==part.length)throw new Problem(404,'object_missing','Source metadata is missing');
   for(const row of sizes){if(!['commit','tree'].includes(row.kind))throw new Problem(400,'source_type','Expected commit or tree metadata');metadataBytes+=Number(row.size);}
   if(metadataBytes>16*1024*1024)throw new Problem(413,'source_seal_budget','Split this changeset batch: metadata exceeds 16 MiB');
   for(const row of await sql`SELECT oid,kind,raw FROM weave_source_objects WHERE project=${project} AND oid=ANY(${part})`)objects.set(row.oid,row);
  }
 }
 await load(pending);const commits=pending.map(id=>{const row=objects.get(id);if(row.kind!=='commit')throw new Problem(400,'source_commit','Expected a source commit');return decodeCommit(id,row.raw);});
 const external=[...new Set(commits.flatMap(c=>c.parents))].filter(id=>!known.has(id)&&!pending.includes(id));
 if(external.length)for(const row of await sql`SELECT git_oid,id FROM weave_changesets WHERE project=${project} AND git_oid=ANY(${external})`)known.set(row.git_oid,row.id);
 const order=new Set(known.keys());for(const c of commits){if(c.parents.some(id=>!order.has(id)))throw new Problem(404,'changeset_missing','Seal earlier parents before their children');order.add(c.oid);}
 if(!prepared)await load(commits.flatMap(c=>c.parents.slice(0,1)));
 type Walk={commit:string;before:string|null;after:string|null;prefix:string};
 let frontier:Walk[]=prepared?[]:commits.map(c=>({commit:c.oid,before:c.parents[0]?decodeCommit(c.parents[0],objects.get(c.parents[0]).raw).tree:null,after:c.tree,prefix:''}));
 const files=new Map<string,any[]>(commits.map(c=>[c.oid,[]])),trees=new Map<string,TreeEntry[]>();let work=0,fileCount=0;
 if(prepared&&pending.length)files.set(ids[0],prepared.delta.map(f=>({path:f.path,mode:f.mode,...(f.rawMode?{rawMode:f.rawMode}:{}),blob:null,gitOid:f.gitOid})));
 function add(id:string,file:any){if(++fileCount>100000)throw new Problem(413,'source_seal_budget','Split this changeset batch: more than 100,000 changed paths');files.get(id)!.push(file);}
 while(frontier.length){const step=frontier.filter(w=>w.before!==w.after);frontier=[];work+=step.length;if(work>8192)throw new Problem(413,'source_seal_budget','Split this changeset batch: more than 8,192 changed trees');
  await load(step.flatMap(w=>[w.before,w.after].filter((id):id is string=>!!id)));
  const tree=(id:string|null)=>{if(!id)return [];if(!trees.has(id)){const row=objects.get(id);if(row.kind!=='tree')throw new Problem(400,'source_tree','Expected a source tree');const entries=decodeTree(row.raw);treeEntries+=entries.length;if(treeEntries>250000)throw new Problem(413,'source_seal_budget','Split this changeset batch: more than 250,000 tree entries');trees.set(id,entries);}return trees.get(id)!;};
  for(const w of step){const a=new Map(tree(w.before).map(e=>[e.name,e])),b=new Map(tree(w.after).map(e=>[e.name,e]));
   for(const name of new Set([...a.keys(),...b.keys()])){const old=a.get(name),next=b.get(name),path=w.prefix?w.prefix+'/'+name:name;if(old?.oid===next?.oid&&old?.mode===next?.mode&&old?.rawMode===next?.rawMode)continue;
    if(old?.type==='tree'||next?.type==='tree'){
     if(old&&old.type!=='tree')add(w.commit,{path,mode:null,blob:null,gitOid:null});
     frontier.push({commit:w.commit,before:old?.type==='tree'?old.oid:null,after:next?.type==='tree'?next.oid:null,prefix:path});
     if(next?.type==='tree'||!next)continue;
    }
    add(w.commit,next?{path,mode:next.mode,...(next.rawMode?{rawMode:next.rawMode}:{}),blob:null,gitOid:next.oid}:{path,mode:null,blob:null,gitOid:null});
   }
  }
 }
 const blobIds=[...new Set([...files.values()].flat().filter(f=>f.mode&&f.mode!=='160000').map(f=>f.gitOid))],blobs=new Map<string,string>();
 for(let i=0;i<blobIds.length;i+=2000){const part=blobIds.slice(i,i+2000),rows=await sql`SELECT o.oid,o.blob FROM weave_source_objects o JOIN weave_source_blobs b ON b.hash=o.blob WHERE o.project=${project} AND o.kind='blob' AND o.oid=ANY(${part}) AND b.state='ready'`;if(rows.length!==part.length)throw new Problem(409,'source_incomplete','Changed blob is missing');for(const row of rows)blobs.set(row.oid,row.blob);}
 const manifests=commits.map(c=>{const delta=files.get(c.oid)!;delta.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);for(const file of delta)if(file.mode&&file.mode!=='160000')file.blob=blobs.get(file.gitOid);
  const data=Buffer.from(objects.get(c.oid).raw),split=data.indexOf('\n\n'),metadata={rawSuffix:data.subarray(data.indexOf(10)+1).toString('base64'),headers:data.subarray(0,split).toString().split('\n').filter(line=>!line.startsWith('tree ')),message:c.message};
  const parents=c.parents.map(id=>known.get(id)!),manifest={version:1,parents,files:delta,metadata},id=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');known.set(c.oid,id);return {project,id,git_oid:c.oid,parents,files:sql.json(delta),metadata:sql.json(metadata)};
 });
 await sql.begin(async tx=>{
  if(manifests.length)await tx`INSERT INTO weave_changesets ${tx(manifests,'project','id','git_oid','parents','files','metadata')} ON CONFLICT DO NOTHING`;
  const graphInputs=new Map(commits.map(c=>[c.oid,{...c,generation:null,depth:0,span:0,treeSpan:0,jumps:[]}]));
  await completeGraphBatch(tx,project,ids,graphInputs);
  const pathInputs=new Map(commits.map(c=>{const delta=files.get(c.oid)!;return [c.oid,{firstParent:c.parents[0]??null,paths:delta.map(f=>f.path),bytes:Buffer.byteLength(JSON.stringify(delta))}];}));
  await completePathBatch(tx,project,ids,pathInputs);
 });
 return {completed:ids.length};
}

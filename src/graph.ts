import type {TransactionSql} from 'postgres';
import {createHash,randomUUID} from 'node:crypto';
import {Problem} from './types.ts';
import {resolveDerivedBatch} from './derived-data.ts';
import type {Commit,Repository,Sql} from './types.ts';

type Node=Commit & {generation:number|null;depth:number;span:number;treeSpan:number;jumps:string[]};
export function deriveGraphNode(input:Commit,parents:Node[]):Node{
 const first=parents[0];return {...input,generation:1+Math.max(0,...parents.map(p=>p.generation!)),depth:first?first.depth+1:0,span:parents.length===1?first.span+1:0,treeSpan:first&&first.tree===input.tree?first.treeSpan+1:0,jumps:first?[first.oid]:[]};
}
const VERSION=1;
const QUERY_NODES=50000;
export function commitGraph(sql:Sql,project:string,repo:Pick<Repository,'commit'>){
 const nodes=new Map<string,Node>();
 const valid=(oid:string)=>{if(typeof oid!=='string'||!/^[a-f0-9]{40}$/.test(oid))throw new Problem(400,'invalid_ref','Use an immutable commit ID');return oid;};
 const decode=(r:any):Node=>({oid:r.oid,tree:r.tree,parents:r.parents,message:r.message,generation:r.generation===null?null:Number(r.generation),depth:Number(r.first_depth),span:Number(r.linear_span),treeSpan:Number(r.tree_span),jumps:r.jumps});
 async function get(oid:string){
  valid(oid);if(nodes.has(oid))return nodes.get(oid)!;
  const [row]=await sql`SELECT * FROM weave_commit_graph WHERE project=${project} AND version=${VERSION} AND oid=${oid}`;
  if(!row)return null;if(nodes.size>=QUERY_NODES)throw new Problem(422,'query_budget','Graph query exceeds its node budget');
  const node=decode(row);nodes.set(oid,node);return node;
 }
 async function complete(oid:string){const node=await get(oid);if(!node||node.generation===null)throw new Problem(409,'index_required','Complete the bounded commit index before querying this history',{ref:oid});return node;}
 async function getMany(ids:string[]){
  const missing=[...new Set(ids)].filter(id=>!nodes.has(id));missing.forEach(valid);
  if(nodes.size+missing.length>QUERY_NODES)throw new Problem(422,'query_budget','Graph query exceeds its node budget');
  for(let at=0;at<missing.length;at+=256)for(const row of await sql`SELECT * FROM weave_commit_graph WHERE project=${project} AND version=${VERSION} AND oid=ANY(${missing.slice(at,at+256)})`)nodes.set(row.oid,decode(row));
 }
 // Resolve many first-parent depths with one SQL batch per jump round. Path
 // candidates can share the proof without 256 independent graph traversals.
 async function firstAncestors(start:string,depths:number[]){
  const root=await complete(start),wanted=[...new Set(depths)];
  if(wanted.length>256||wanted.some(d=>!Number.isSafeInteger(d)||d<0||d>root.depth))throw new Problem(422,'query_budget','Request at most 256 valid ancestor depths');
  const current=new Map(wanted.map(depth=>[depth,root]));
  while(true){
   const next=new Map<number,string>();
   for(const [depth,node]of current)if(node.depth>depth){const id=node.jumps[Math.floor(Math.log2(node.depth-depth))];if(!id)throw new Problem(503,'index_invalid','Commit index needs rebuilding');next.set(depth,id);}
   if(!next.size)break;await getMany([...next.values()]);
   for(const [depth,id]of next){const node=await complete(id);if(node.depth>=current.get(depth)!.depth||node.depth<depth)throw new Problem(503,'index_invalid','Invalid first-parent jump');current.set(depth,node);}
  }
  return new Map([...current].map(([depth,node])=>[depth,node.oid]));
 }

 async function ingest(root:string,records:unknown){
  valid(root);if(!Array.isArray(records)||!records.length||records.length>256)throw new Problem(400,'index_batch','Supply 1–256 raw Git commits');
  const parsed=new Map<string,Commit>();let bytes=0;
  for(const record of records){
   valid(record?.oid);if(typeof record.body!=='string'||record.body.length>1400000)throw new Problem(400,'index_body','Supply a base64 Git commit body');
   const raw=Buffer.from(record.body,'base64');bytes+=raw.length;if(bytes>1024*1024)throw new Problem(413,'index_size','Commit metadata batch exceeds 1 MiB');
   const hash=createHash('sha1').update(`commit ${raw.length}\0`).update(raw).digest('hex');
   if(raw.toString('base64')!==record.body||hash!==record.oid||parsed.has(hash))throw new Problem(400,'index_hash','Commit body identity is invalid or duplicated');
   const separator=raw.indexOf('\n\n');if(separator<0)throw new Problem(400,'index_commit','Invalid Git commit headers');
   const headers=raw.subarray(0,separator).toString(),trees=[...headers.matchAll(/^tree ([a-f0-9]{40})$/gm)],parents=[...headers.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m=>m[1]);
   if(trees.length!==1||parents.length>256)throw new Problem(400,'index_commit','Invalid or excessive Git commit parents');
   parsed.set(hash,{oid:hash,tree:trees[0][1],parents,message:raw.subarray(separator+2).toString()});
  }
  const anchored=await get(root)??await repo.commit(root);if(!anchored)throw new Problem(404,'commit_missing','Index root does not exist in this repository');
  const ids=[...parsed.keys()];const known=await sql`SELECT oid,parents FROM weave_commit_graph WHERE project=${project} AND version=${VERSION} AND (oid=ANY(${ids}) OR parents && ${ids}::text[])`;
  const allowed=new Set<string>([root,...anchored.parents]);for(const node of known){allowed.add(node.oid);for(const parent of node.parents)allowed.add(parent);}
  const remaining=new Map(parsed);while(remaining.size){let progress=false;for(const [oid,node] of remaining)if(allowed.has(oid)){remaining.delete(oid);node.parents.forEach(p=>allowed.add(p));progress=true;}if(!progress)throw new Problem(400,'index_unreachable','Commit batch is not linked to provider-anchored repository history');}
  const all=new Map(parsed);if(!all.has(root))all.set(root,anchored);
  const rows=[...all.values()].map(c=>({project,version:VERSION,oid:c.oid,tree:c.tree,parents:c.parents,message:c.message}));
  const inserted=await sql`INSERT INTO weave_commit_graph ${sql(rows,'project','version','oid','tree','parents','message')} ON CONFLICT DO NOTHING RETURNING oid`;
  for(const row of inserted){const c=all.get(row.oid)!;nodes.set(c.oid,{...c,generation:null,depth:0,span:0,treeSpan:0,jumps:[]});}
  return {ref:root,accepted:inserted.filter(row=>parsed.has(row.oid)).length,received:records.length,bytes};
 }

 // Only immutable provider data enters the index. A generation is published after
 // every parent is complete, so an incomplete import cannot yield false ancestry.
 async function build(root:string,limit=64){
  valid(root);if(!Number.isInteger(limit)||limit<1||limit>128)throw new Problem(400,'index_limit','Index steps read 1–128 new commits');
  const existing=await get(root);if(existing?.generation!==null&&existing)return {ref:root,complete:true,reads:0,completed:0,pending:0,generation:existing.generation};
  const owner=randomUUID();
  const [job]=await sql`INSERT INTO weave_graph_builds(project,version,root,stack,lease,lease_until) VALUES(${project},${VERSION},${root},${[root]},${owner},now()+interval '5 minutes') ON CONFLICT(project,version,root) DO UPDATE SET lease=EXCLUDED.lease,lease_until=EXCLUDED.lease_until WHERE weave_graph_builds.lease IS NULL OR weave_graph_builds.lease_until<now() RETURNING stack`;
  if(!job)throw new Problem(409,'index_busy','An index step is already active; no new provider calls were started');
  const stack:string[]=job.stack;let reads=0,completed=0,work=0;const started=Date.now();
  try{
   while(stack.length&&work++<limit*4+64&&Date.now()-started<25000){
    const oid=stack.at(-1)!;let node=await get(oid);
    if(node?.generation!==null&&node){stack.pop();continue;}
    if(!node){
     if(reads>=limit)break;reads++;
     const c=await repo.commit(oid);if(!c)throw new Problem(404,'commit_missing','Commit not found');
     await sql`INSERT INTO weave_commit_graph(project,version,oid,tree,parents,message) VALUES(${project},${VERSION},${oid},${c.tree},${c.parents},${c.message}) ON CONFLICT DO NOTHING`;
     node={...c,generation:null,depth:0,span:0,treeSpan:0,jumps:[]};nodes.set(oid,node);
    }
    const parents:Node[]=[];let missing:string|undefined;
    for(const parent of node.parents){const p=await get(parent);if(!p||p.generation===null){missing=parent;break;}parents.push(p);}
    if(missing){if(stack.length>=100000)throw new Problem(422,'index_depth','Index ancestry exceeds 100,000 pending commits');stack.push(missing);continue;}
    await completeGraphBatch(sql,project,[oid],nodes);stack.pop();completed++;
   }
   const result=await get(root);return {ref:root,complete:result?.generation!==null&&!!result,reads,completed,pending:stack.length,generation:result?.generation??null};
  }finally{
   // A late step cannot overwrite a newer lease's continuation. Completed nodes
   // remain useful even if the process exits before saving this stack.
   await sql`UPDATE weave_graph_builds SET stack=${stack},lease=NULL,lease_until=NULL WHERE project=${project} AND version=${VERSION} AND root=${root} AND lease=${owner}`;
  }
 }
 async function ensure(...roots:string[]){
  for(const root of roots){valid(root);const node=await get(root);if(node&&node.generation!==null)continue;const result=await build(root,64);if(!result.complete)throw new Problem(409,'index_required','History needs more bounded indexing steps',{ref:root,pending:result.pending});}
 }
 async function firstAncestor(start:string,distance:number){
  let node=await complete(start);if(distance>node.depth)return null;
  while(distance>0){const level=Math.floor(Math.log2(distance));const next=node.jumps[level];if(!next)throw new Problem(503,'index_invalid','Commit index needs rebuilding');node=await complete(next);distance-=2**level;}return node;
 }
 async function ancestry(ancestor:string,descendant:string){
  await ensure(ancestor,descendant);const target=await complete(ancestor);const pending=[descendant],seen=new Set<string>();
  const tip=await complete(descendant),distance=tip.depth-target.depth;
  if(distance>=0&&(await firstAncestor(descendant,distance))?.oid===ancestor)return {isAncestor:true,ancestor,descendant};
  while(pending.length){const oid=pending.pop()!;if(oid===ancestor)return {isAncestor:true,ancestor,descendant};if(seen.has(oid))continue;if(seen.size>=QUERY_NODES)throw new Problem(422,'query_budget','Graph query exceeds its node budget');seen.add(oid);
   const node=await complete(oid);if(node.generation!<=target.generation!)continue;
   const distance=Math.min(node.span,node.generation!-target.generation!);
   if(distance>0){pending.push((await firstAncestor(oid,2**Math.floor(Math.log2(distance))))!.oid);}else pending.push(...node.parents);
  }
  return {isAncestor:false,ancestor,descendant};
 }
 async function mergeBase(left:string,right:string){
  await ensure(left,right);
  // A proven first-parent ancestor is the unique best common ancestor.
  // Answer this common mainline query with jumps before painting merge edges.
  const a=await complete(left),b=await complete(right);
  if(a.depth<=b.depth&&(await firstAncestor(right,b.depth-a.depth))?.oid===left)return {bases:[left]};
  if(b.depth<a.depth&&(await firstAncestor(left,a.depth-b.depth))?.oid===right)return {bases:[right]};
  // Paint both sides in descending generation order. Common ancestors become
  // stale; stop when only their stale ancestry remains. This retains all best
  // bases, including criss-cross merges, without walking the shared prefix.
  const flags=new Map<string,number>(),done=new Set<string>(),heap:Node[]=[],bases:string[]=[];let active=0;
  function push(node:Node){heap.push(node);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].generation!>=node.generation!)break;heap[i]=heap[p];i=p;}heap[i]=node;}
  function pop(){const top=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].generation!>heap[c].generation!)c++;if(heap[c].generation!<=last.generation!)break;heap[i]=heap[c];i=c;}heap[i]=last;}return top;}
  async function mark(oid:string,mask:number){const old=flags.get(oid)??0,next=old|mask;if(old===next)return;if(!old){if(flags.size>=QUERY_NODES)throw new Problem(422,'query_budget','Merge-base query exceeds its node budget');push(await complete(oid));if(!(next&4))active++;}else if(!(old&4)&&(next&4)&&!done.has(oid))active--;flags.set(oid,next);}
  await mark(left,1);await mark(right,2);
  while(active>0&&heap.length){const node=pop();done.add(node.oid);let mask=flags.get(node.oid)!;if(!(mask&4))active--;if(mask===3){bases.push(node.oid);mask|=4;}for(const parent of node.parents)await mark(parent,mask);}
  return {bases:bases.sort()};
 }
 async function bisect(good:string,bad:string){
  await ensure(good,bad);const a=await complete(good),b=await complete(bad),remaining=b.depth-a.depth;
  if(remaining<0||(await firstAncestor(bad,remaining))?.oid!==good)throw new Problem(409,'bisect_range','Good must be on the bad commit’s first-parent chain');
  return {order:'first-parent',culprit:remaining===1?bad:null,candidate:remaining>1?(await firstAncestor(bad,Math.floor(remaining/2)))!.oid:null,remaining};
 }
 async function firstAncestry(ancestor:string,descendant:string){
  await ensure(ancestor,descendant);const a=await complete(ancestor),b=await complete(descendant),distance=b.depth-a.depth;
  return distance>=0&&(await firstAncestor(descendant,distance))?.oid===ancestor;
 }
 async function unchanged(oid:string){const node=await get(oid);return node?.generation!==null&&node?.treeSpan?(await firstAncestor(oid,node.treeSpan))!.oid:oid;}
 async function status(root:string){
  valid(root);const node=await get(root);const [job]=await sql`SELECT cardinality(stack) AS pending,lease IS NOT NULL AND lease_until>now() AS active FROM weave_graph_builds WHERE project=${project} AND version=${VERSION} AND root=${root}`;
  return {ref:root,complete:!!node&&node.generation!==null,generation:node?.generation??null,pending:Number(job?.pending??0),active:job?.active??false};
 }
 return {build,ancestry,mergeBase,bisect,get,unchanged,status,ingest,firstAncestry,firstAncestors};
}

/** Complete imported, already hash-verified metadata in parent-order batches.
 * Jump dependencies are fetched a level at a time, avoiding one SQL round trip per jump per commit.
 */
export async function completeGraphBatch(sql:Sql|TransactionSql<{}>,project:string,ids:string[],memo=new Map<string,Node>()){
 if(!ids.length||ids.length>256)throw new Problem(400,'index_batch','Complete 1–256 imported commits');
 const nodes=new Map(memo);let metadataBytes=0;
 const decode=(r:any):Node=>({oid:r.oid,tree:r.tree,parents:r.parents,message:r.message,generation:r.generation===null?null:Number(r.generation),depth:Number(r.first_depth),span:Number(r.linear_span),treeSpan:Number(r.tree_span),jumps:r.jumps});
 async function read(keys:string[]){const missing=keys.filter(key=>!nodes.has(key));if(missing.length)for(const r of await sql`SELECT * FROM weave_commit_graph WHERE project=${project} AND version=1 AND oid=ANY(${missing})`)nodes.set(r.oid,decode(r));return new Map(keys.filter(key=>nodes.get(key)?.generation!=null).map(key=>[key,nodes.get(key)!]));}
 const result=await resolveDerivedBatch<Node,Node>({kind:'commit-graph',version:VERSION,read,
  async load(keys){
   const missing=keys.filter(key=>!nodes.has(key));
   if(missing.length){const sizes=await sql`SELECT size FROM weave_source_objects WHERE project=${project} AND kind='commit' AND oid=ANY(${missing})`;metadataBytes+=sizes.reduce((total,row)=>total+Number(row.size),0);if(metadataBytes>16*1024*1024)throw new Problem(422,'derived_budget','Derive earlier graph batches first: metadata exceeds 16 MiB');}
   if(missing.length)for(const row of await sql`SELECT oid,raw FROM weave_source_objects WHERE project=${project} AND kind='commit' AND oid=ANY(${missing})`){
    const raw=Buffer.from(row.raw),at=raw.indexOf('\n\n'),header=raw.subarray(0,at).toString(),tree=header.match(/^tree ([a-f0-9]{40})$/m)?.[1];
    if(at<0||!tree||createHash('sha1').update(`commit ${raw.length}\0`).update(raw).digest('hex')!==row.oid)throw new Problem(503,'index_input','Canonical Git metadata is invalid');
    nodes.set(row.oid,{oid:row.oid,tree,parents:[...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m=>m[1]),message:raw.subarray(at+2).toString(),generation:null,depth:0,span:0,treeSpan:0,jumps:[]});
   }
   return new Map(keys.filter(key=>nodes.has(key)).map(key=>[key,{key,parents:nodes.get(key)!.parents,input:nodes.get(key)!}]));
  },
  async compute(inputs,resolved){
   const values=new Map<string,Node>();
   for(const {key,input,parents:ids} of inputs){const node=deriveGraphNode(input,ids.map(id=>resolved.get(id)!));values.set(key,node);nodes.set(key,node);resolved.set(key,node);}
   // One fetch per jump level, shared by all commits in the admitted batch.
   for(let level=1;level<32;level++){
    const active=[...values.values()].filter(node=>node.jumps.length===level);if(!active.length)break;
    await read([...new Set(active.map(node=>node.jumps[level-1]))]);
    for(const node of active){const previous=nodes.get(node.jumps[level-1]);if(!previous||previous.generation===null)throw new Problem(503,'index_invalid','Jump dependency is incomplete');if(previous.jumps[level-1])node.jumps.push(previous.jumps[level-1]);}
   }
   return values;
  },
  async save(values){
   const rows=[...values.values()].map(n=>({project,version:VERSION,oid:n.oid,tree:n.tree,parents:n.parents,message:n.message,generation:n.generation!,first_depth:n.depth,linear_span:n.span,tree_span:n.treeSpan,jumps:n.jumps}));
   for(let at=0;at<rows.length;at+=256)await sql`INSERT INTO weave_commit_graph ${sql(rows.slice(at,at+256),'project','version','oid','tree','parents','message','generation','first_depth','linear_span','tree_span','jumps')} ON CONFLICT(project,version,oid) DO UPDATE SET generation=EXCLUDED.generation,first_depth=EXCLUDED.first_depth,linear_span=EXCLUDED.linear_span,tree_span=EXCLUDED.tree_span,jumps=EXCLUDED.jumps WHERE weave_commit_graph.generation IS NULL`;
  }
 },ids);
 for(const [key,node]of nodes)memo.set(key,node);
 return {completed:result.computed};
}

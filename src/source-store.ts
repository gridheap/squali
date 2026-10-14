import {sealSourceBatch} from './source-seal.ts';
import {sourceExporter} from './source-export.ts';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync,inflateSync} from 'node:zlib';
import {Problem} from './types.ts';
import {derivedData} from './derived-data.ts';
import {completeGraphBatch,commitGraph} from './graph.ts';
import type {Artifacts,Commit,RawObject,Repository,Sql,TreeEntry} from './types.ts';
export interface SourceBucket {
 get(key:string):Promise<{arrayBuffer():Promise<ArrayBuffer>}|null>;
 head(key:string):Promise<{size:number;customMetadata?:Record<string,string>}|null>;
 put(key:string,body:Uint8Array,options:{customMetadata:Record<string,string>;httpMetadata:{contentType:string}}):Promise<unknown>;
}
export type SourceStore=ReturnType<typeof sourceStore>;
const hash=(algorithm:string,data:Uint8Array|string)=>createHash(algorithm).update(data).digest('hex');
const oid=(type:string,data:Uint8Array)=>createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
const immutable=(id:string)=>{if(!/^[a-f0-9]{40}$/.test(id))throw new Problem(400,'object_id','Use an immutable Git object ID');};
function decodeCommit(id:string,raw:Uint8Array):Commit{
 const text=Buffer.from(raw).toString(),at=text.indexOf('\n\n'),header=text.slice(0,at);
 const tree=header.match(/^tree ([a-f0-9]{40})$/m)?.[1];if(at<0||!tree)throw new Problem(400,'source_commit','Malformed Git commit');
 return {oid:id,tree,parents:[...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m=>m[1]),message:text.slice(at+2)};
}
function decodeTree(raw:Uint8Array):TreeEntry[]{
 const data=Buffer.from(raw),entries:TreeEntry[]=[];let at=0;
 while(at<data.length){const space=data.indexOf(32,at),nul=data.indexOf(0,space+1);if(space<at||nul<space||nul+21>data.length)throw new Problem(400,'source_tree','Malformed Git tree');const rawMode=data.subarray(at,space).toString(),bits=/^[0-7]{5,6}$/.test(rawMode)?parseInt(rawMode,8):0,kind=bits&0o170000,mode=kind===0o100000?(bits&0o100?'100755':'100644'):kind.toString(8),name=data.subarray(space+1,nul).toString();if(!['40000','100644','100755','120000','160000'].includes(mode)||!name||name.includes('/')||name==='.'||name==='..')throw new Problem(400,'source_tree','Invalid tree entry');entries.push({mode,...(rawMode!==mode?{rawMode}:{}),name,oid:data.subarray(nul+1,nul+21).toString('hex'),type:mode==='40000'?'tree':mode==='160000'?'commit':'blob'});at=nul+21;}
 return entries;
}
// Packs made by the incremental writer contain independent zlib objects only.
// Import uses raw, hash-verified batches rather than retaining Git delta packs.
function unpackWrittenPack(input:Uint8Array):RawObject[]{
 const data=Buffer.from(input);if(data.length<32||data.subarray(0,4).toString()!=='PACK'||data.readUInt32BE(4)!==2||hash('sha1',data.subarray(0,-20))!==data.subarray(-20).toString('hex'))throw new Problem(400,'source_pack','Invalid incremental pack');
 const count=data.readUInt32BE(8);if(count>8192||data.length>16*1024*1024)throw new Problem(413,'source_pack','Incremental write exceeds its bound');const result:RawObject[]=[];let at=12,total=0;
 for(let i=0;i<count;i++){let byte=data[at++],size=byte&15,shift=4;const kind=byte>>4&7;while(byte&128){if(at>=data.length-20||shift>28)throw new Problem(400,'source_pack','Invalid object size');byte=data[at++];size+=(byte&127)*2**shift;shift+=7;}
  const type=({1:'commit',2:'tree',3:'blob',4:'tag'} as const)[kind as 1];if(!type||size>32*1024*1024)throw new Problem(400,'source_pack','Incremental writes require independent bounded objects');
  const decoded=inflateSync(data.subarray(at,-20),{info:true,maxOutputLength:32*1024*1024}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
  if(decoded.buffer.length!==size)throw new Problem(400,'source_pack','Object length mismatch');at+=decoded.engine.bytesWritten;total+=size;if(total>64*1024*1024)throw new Problem(413,'source_pack','Expanded incremental write exceeds 64 MiB');result.push({type,oid:oid(type,decoded.buffer),data:decoded.buffer});
 }
 if(at!==data.length-20)throw new Problem(400,'source_pack','Trailing pack bytes');return result;
}
export function sourceStore(sql:Sql,bucket:SourceBucket,caps:{reads:number;writes:number;repositoryBytes:number},cache?:import('./cache.ts').ObjectCache){
 let exportBridge:ReturnType<typeof sourceExporter>;
 async function reserve(kind:'reads'|'writes',n=1){const cap=caps[kind];if(!Number.isSafeInteger(cap)||cap<1)throw new Problem(503,'source_config','Source operation budget is not configured');const month=new Date().toISOString().slice(0,7);const rows=await sql`INSERT INTO weave_source_usage(month,kind,attempts) SELECT ${month},${kind},${n} WHERE ${n}::bigint<=${cap}::bigint ON CONFLICT(month,kind) DO UPDATE SET attempts=weave_source_usage.attempts+${n} WHERE weave_source_usage.attempts+${n}<=${cap} RETURNING attempts`;if(!rows.length)throw new Problem(429,'source_budget','Authoritative source operation budget exhausted');}
 async function row(project:string,id:string){immutable(id);const [value]=await sql`SELECT o.*,b.state AS blob_state FROM weave_source_objects o LEFT JOIN weave_source_blobs b ON b.hash=o.blob WHERE o.project=${project} AND o.oid=${id}`;return value;}
 async function raw(project:string,id:string){const value=await row(project,id);if(!value)throw new Problem(404,'object_missing','Source object not found');if(value.kind!=='blob')return Buffer.from(value.raw);if(value.blob_state!=='ready')throw new Problem(503,'source_pending','Source blob acceptance has not been confirmed');
  const cacheKey='source/'+project+'/blob/'+id;
  if(cache){let hit;try{hit=await cache.get(cacheKey);}catch{throw new Problem(503,'source_cache','Source cache is unavailable; no bypass attempted');}if(hit!==undefined){if(!(hit instanceof Uint8Array)||hit.length!==Number(value.size)||hash('sha256',hit)!==value.blob||oid('blob',hit)!==id)throw new Problem(503,'source_cache_corrupt','Cached source identity mismatch');return Buffer.from(hit);}}
  await reserve('reads');let object;try{object=await bucket.get('blobs/v1/'+value.blob);}catch{throw new Problem(503,'source_unavailable','Authoritative blob storage is unavailable');}if(!object)throw new Problem(503,'source_missing','Authoritative blob is missing; no origin fallback was attempted');
  let data:Buffer;try{const compressed=await object.arrayBuffer();if(compressed.byteLength>33*1024*1024)throw Error();data=gunzipSync(Buffer.from(compressed),{maxOutputLength:32*1024*1024});}catch{throw new Problem(503,'source_corrupt','Invalid compressed source blob');}
  if(data.length!==Number(value.size)||hash('sha256',data)!==value.blob||oid('blob',data)!==id)throw new Problem(503,'source_corrupt','Source blob identity mismatch');if(cache)try{await cache.set(cacheKey,data);}catch{throw new Problem(503,'source_cache','Source cache fill failed; no direct bypass enabled');}return data;
 }
 async function objects(project:string,values:(RawObject & {compressed?:Uint8Array})[]){
  if(values.length>8192)throw new Problem(413,'source_objects','Too many objects');let bytes=0;
  for(const value of values){immutable(value.oid);bytes+=value.data.length;if(value.data.length>32*1024*1024||bytes>64*1024*1024)throw new Problem(413,'source_objects','Object upload exceeds its bound');if(!['commit','tree','blob','tag'].includes(value.type)||oid(value.type,value.data)!==value.oid)throw new Problem(400,'source_hash','Git object identity mismatch');if(value.type==='commit')decodeCommit(value.oid,value.data);if(value.type==='tree')decodeTree(value.data);}
  const prepared=[...new Map(values.map(value=>[value.oid,value])).values()].map(value=>({...value,blob:value.type==='blob'?hash('sha256',value.data):null,compressed:value.type==='blob'?(value.compressed??gzipSync(value.data,{level:1})):null}));
  const [claim,inserted]=await sql.begin(async tx=>{
   const blobs=prepared.filter(v=>v.blob).map(v=>({hash:v.blob!,size:v.data.length,compressed_size:v.compressed!.length}));
   const uniqueBlobs=[...new Map(blobs.map(v=>[v.hash,v])).values()];
   const claimed=uniqueBlobs.length?await tx`INSERT INTO weave_source_blobs ${tx(uniqueBlobs,'hash','size','compressed_size')} ON CONFLICT DO NOTHING RETURNING hash`:[];
   const rows=prepared.map(v=>({project,oid:v.oid,kind:v.type,size:v.data.length,blob:v.blob,raw:v.type==='blob'?null:Buffer.from(v.data)}));
   const added=rows.length?await tx`INSERT INTO weave_source_objects ${tx(rows,'project','oid','kind','size','blob','raw')} ON CONFLICT DO NOTHING RETURNING size`:[];
   const total=added.reduce((n,r)=>n+Number(r.size),0);if(total){const quota=await tx`INSERT INTO weave_source_bytes(project,bytes) SELECT ${project},${total} WHERE ${total}::bigint<=${caps.repositoryBytes}::bigint ON CONFLICT(project) DO UPDATE SET bytes=weave_source_bytes.bytes+${total} WHERE weave_source_bytes.bytes+${total}<=${caps.repositoryBytes} RETURNING bytes`;if(!quota.length)throw new Problem(413,'source_repository_size','Source repository byte budget exceeded');}
   return [claimed,added.length] as const;
  });
  const claimed=new Set(claim.map(r=>r.hash)),ready:string[]=[];const uploads=prepared.filter(v=>v.blob&&claimed.has(v.blob));
  if(uploads.length)await reserve('writes',uploads.length);
  // Refill each slot as soon as it completes. A slow object must not stall
  // an entire wave; six slots match Workers' pending connection allowance.
  let failed=false,next=0;await Promise.all(Array.from({length:Math.min(6,uploads.length)},async()=>{while(next<uploads.length){const value=uploads[next++];try{await bucket.put('blobs/v1/'+value.blob,value.compressed!,{customMetadata:{sha256:value.blob!,size:String(value.data.length)},httpMetadata:{contentType:'application/gzip'}});ready.push(value.blob!);}catch{failed=true;}}}));
  if(ready.length)await sql`UPDATE weave_source_blobs SET state='ready' WHERE hash=ANY(${ready})`;
  if(failed)throw new Problem(503,'source_upload','Some blob uploads did not complete; resume checks each immutable identity');
  const unclaimed=prepared.filter(v=>v.blob&&!claimed.has(v.blob));
  if(unclaimed.length){const pending=await sql`SELECT hash,compressed_size FROM weave_source_blobs WHERE hash=ANY(${unclaimed.map(v=>v.blob!)}) AND state<>'ready'`;for(const value of pending){await reserve('reads');const found=await bucket.head('blobs/v1/'+value.hash);if(found&&found.customMetadata?.sha256===value.hash&&found.size===Number(value.compressed_size))await sql`UPDATE weave_source_blobs SET state='ready' WHERE hash=${value.hash}`;else {
   if(found)throw new Problem(503,'source_corrupt','Stored blob metadata does not match its immutable claim');
   const input=unclaimed.find(v=>v.blob===value.hash)!;
   const retry=await sql`UPDATE weave_source_blobs SET attempts=attempts+1,compressed_size=${input.compressed!.length},lease_until=now()+interval '5 minutes' WHERE hash=${value.hash} AND state='uploading' AND lease_until<now() AND attempts<3 RETURNING hash`;
   if(!retry.length)throw new Problem(503,'source_pending','Upload lease is active or its three-attempt ceiling is exhausted');
   await reserve('writes');
   try{await bucket.put('blobs/v1/'+value.hash,input.compressed!,{customMetadata:{sha256:value.hash,size:String(input.data.length)},httpMetadata:{contentType:'application/gzip'}});}catch{throw new Problem(503,'source_upload','Bounded immutable upload retry failed');}
   await sql`UPDATE weave_source_blobs SET state='ready',compressed_size=${input.compressed!.length} WHERE hash=${value.hash}`;
  }}}
  return {accepted:inserted,received:values.length};
 }
 async function missing(project:string,ids:unknown){if(!Array.isArray(ids)||ids.length>2000)throw new Problem(400,'source_missing_batch','Request at most 2,000 object identities');ids.forEach(immutable);const found=new Set((await sql`SELECT o.oid FROM weave_source_objects o LEFT JOIN weave_source_blobs b ON b.hash=o.blob WHERE o.project=${project} AND o.oid=ANY(${ids}) AND (o.blob IS NULL OR b.state='ready')`).map(r=>r.oid));return {missing:[...new Set(ids)].filter(id=>!found.has(id))};}
 async function upload(project:string,records:unknown){if(!Array.isArray(records)||!records.length||records.length>128)throw new Problem(400,'source_batch','Upload 1–128 objects');const values:(RawObject & {compressed?:Uint8Array})[]=[];let compressed=0,expanded=0;for(const record of records){immutable(record?.oid);if(record.encoding!=='gzip'||typeof record.body!=='string')throw new Problem(400,'source_encoding','Use gzip with canonical base64');const body=Buffer.from(record.body,'base64');compressed+=body.length;if(compressed>1024*1024)throw new Problem(413,'source_batch','Compressed batch exceeds 1 MiB');if(body.toString('base64')!==record.body)throw new Problem(400,'source_encoding','Invalid base64');let data:Buffer;try{data=gunzipSync(body,{maxOutputLength:32*1024*1024});}catch{throw new Problem(400,'source_encoding','Invalid or oversized gzip object');}expanded+=data.length;if(expanded>64*1024*1024)throw new Problem(413,'source_batch','Expanded batch exceeds 64 MiB');values.push({oid:record.oid,type:record.type,data,compressed:body});}return objects(project,values);}
 async function uploadBlob(project:string,id:string,request:Request){
  immutable(id);if(request.headers.get('content-type')!=='application/gzip')throw new Problem(415,'source_encoding','Use application/gzip');
  const reader=request.body?.getReader();if(!reader)throw new Problem(400,'source_encoding','Missing compressed blob');const chunks:Uint8Array[]=[];let bytes=0;
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>33*1024*1024){await reader.cancel();throw new Problem(413,'source_blob','Compressed blob exceeds 33 MiB');}chunks.push(value);}
  const compressed=Buffer.concat(chunks);let data:Buffer;try{data=gunzipSync(compressed,{maxOutputLength:32*1024*1024});}catch{throw new Problem(400,'source_encoding','Invalid or oversized gzip blob');}
  return objects(project,[{oid:id,type:'blob',data,compressed}]);
 }
 async function sealBatch(project:string,ids:unknown){if(!Array.isArray(ids)||!ids.length||ids.length>128)throw new Problem(400,'source_batch','Seal 1–128 commits in parent order');ids.forEach(immutable);return sealSourceBatch(sql,project,ids,decodeCommit,decodeTree);}
 async function finish(project:string,refs:unknown,branch:string,gitBridgeLimited=false){
  if(!Array.isArray(refs)||refs.length>5000||typeof branch!=='string')throw new Problem(400,'source_refs','Supply at most 5,000 refs and the default branch');
  const names=new Set<string>();for(const ref of refs){immutable(ref?.oid);if(typeof ref.name!=='string'||!/^refs\/(heads|tags)\/[^\x00-\x20~^:?*\[\]\\]+$/.test(ref.name)||ref.name.includes('..')||ref.name.includes('@{')||ref.name.endsWith('.lock')||ref.name.endsWith('/')||ref.name.includes('//')||names.has(ref.name))throw new Problem(400,'source_ref','Invalid or repeated ref');names.add(ref.name);}
  const ordered=[...refs].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),identity=hash('sha256',JSON.stringify({refs:ordered,defaultBranch:branch})),main='refs/heads/'+branch,head=refs.find(r=>r.name===main)?.oid??null;if(refs.length&&!head)throw new Problem(409,'source_default_branch','Default branch is not present');
  const [p]=await sql`SELECT state,source_manifest FROM weave_projects WHERE id=${project}`;if(p.source_manifest===identity&&p.state==='ready')return {state:'ready',head};if(p.state!=='importing')throw new Problem(409,'source_import_state','Only an uninitialized import can install refs');
  const checked=new Map<string,any>();let pending:any[]=refs.map(ref=>({id:ref.oid,expected:ref.name.startsWith('refs/heads/')?'commit':null,depth:0})),treeBytes=0,treeCount=0,entries=0;const seenTrees=new Set<string>();
  while(pending.length){const current=pending;pending=[];const missing=[...new Set<string>(current.map(v=>v.id))].filter(id=>!checked.has(id));
   for(let i=0;i<missing.length;i+=2000){const values=await sql`SELECT o.oid,o.kind,o.size,substring(o.raw from 1 for 256) AS prefix,b.state AS blob_state,c.id AS changeset FROM weave_source_objects o LEFT JOIN weave_source_blobs b ON b.hash=o.blob LEFT JOIN weave_changesets c ON c.project=o.project AND c.git_oid=o.oid WHERE o.project=${project} AND o.oid=ANY(${missing.slice(i,i+2000)})`;for(const value of values)checked.set(value.oid,value);}
   for(const item of current){const value=checked.get(item.id);if(!value||item.expected&&value.kind!==item.expected)throw new Problem(409,'source_incomplete','A ref target is missing or has the wrong object type');
    if(value.kind==='tag'){if(item.depth>=16)throw new Problem(422,'source_tag_depth','Annotated tag chain exceeds its bound');const header=Buffer.from(value.prefix).toString(),target=header.match(/^object ([a-f0-9]{40})$/m)?.[1],type=header.match(/^type (commit|tree|blob|tag)$/m)?.[1];if(!target||!type)throw new Problem(400,'source_tag','Malformed annotated tag');pending.push({id:target,expected:type,depth:item.depth+1});}
    else if(value.kind==='commit'){if(!value.changeset)throw new Problem(409,'source_incomplete','A referenced changeset is incomplete');}
    else if(value.kind==='blob'){if(value.blob_state!=='ready')throw new Problem(409,'source_incomplete','A tagged blob has not been confirmed');}
    else if(value.kind==='tree'&&!seenTrees.has(value.oid)){seenTrees.add(value.oid);treeBytes+=Number(value.size);if(++treeCount>8192||treeBytes>16*1024*1024)throw new Problem(422,'source_tag_tree_budget','Standalone tagged-tree validation exceeds its bounded step');const children=await tree(project,value.oid);entries+=children.length;if(entries>100000)throw new Problem(422,'source_tag_tree_budget','Standalone tagged trees exceed 100,000 entries');pending.push(...children.filter(child=>child.mode!=='160000').map(child=>({id:child.oid,expected:child.type,depth:0})));}
   }
  }
  await sql.begin(async tx=>{const [current]=await tx`SELECT state,source_manifest FROM weave_projects WHERE id=${project} FOR UPDATE`;if(current.source_manifest===identity&&current.state==='ready')return;if(current.state!=='importing')throw new Problem(409,'source_import_state','Import state changed');if(ordered.length)await tx`INSERT INTO weave_source_refs ${tx(ordered.map(r=>({project,name:r.name,oid:r.oid})),'project','name','oid')}`;await tx`UPDATE weave_projects SET state='ready',head=${head},main_ref=${main},source_manifest=${identity},git_bridge_limited=${gitBridgeLimited} WHERE id=${project}`;await tx`UPDATE weave_github_imports SET state='complete',engine='source',head=${head},refs=${tx.json(ordered)},error=NULL,updated_at=now() WHERE project_id=${project}`;await tx`UPDATE weave_native_jobs SET state='complete',updated_at=now() WHERE import_id IN (SELECT id FROM weave_github_imports WHERE project_id=${project})`;await tx`UPDATE weave_tokens SET revoked_at=now() WHERE id IN (SELECT j.token_id FROM weave_native_jobs j JOIN weave_github_imports i ON i.id=j.import_id WHERE i.project_id=${project})`;});return {state:'ready',head};
 }

 const tree=async(project:string,id:string)=>{const value=await row(project,id);if(!value||value.kind!=='tree')throw new Problem(404,'tree_missing','Source tree not found');return decodeTree(value.raw);};
 const commit=async(project:string,id:string)=>{const value=await row(project,id);return value?.kind==='commit'?decodeCommit(id,value.raw):null;};
 async function changeset(project:string,id:string){const [value]=await sql`SELECT * FROM weave_changesets WHERE project=${project} AND (id=${id} OR git_oid=${id})`;if(!value)throw new Problem(404,'changeset_missing','Changeset is not complete');return {id:value.id,gitOid:value.git_oid,parents:value.parents,files:value.files,metadata:value.metadata};}
 async function seal(project:string,id:string){
  const [existing]=await sql`SELECT id FROM weave_changesets WHERE project=${project} AND git_oid=${id}`;if(existing)return changeset(project,id);
  const c=await commit(project,id);if(!c)throw new Problem(404,'commit_missing','Source commit not found');const parents=[];for(const parent of c.parents)parents.push((await changeset(project,parent)).id);
  const first=c.parents[0]?await commit(project,c.parents[0]):null;const files:any[]=[];let work=0;
  async function walk(before:string|null,after:string|null,prefix:string){if(before===after)return;if(++work>8192)throw new Problem(422,'source_tree_budget','Changeset derivation exceeds 8,192 changed trees');const a=new Map((before?await tree(project,before):[]).map(v=>[v.name,v])),b=new Map((after?await tree(project,after):[]).map(v=>[v.name,v]));
   for(const name of [...new Set([...a.keys(),...b.keys()])].sort()){const old=a.get(name),next=b.get(name),path=prefix?prefix+'/'+name:name;if(old?.oid===next?.oid&&old?.mode===next?.mode&&old?.rawMode===next?.rawMode)continue;
    if(old?.type==='tree'||next?.type==='tree'){if(old&&old.type!=='tree')files.push({path,mode:null,blob:null,gitOid:null});if(old?.type==='tree')await walk(old.oid,next?.type==='tree'?next.oid:null,path);else if(next?.type==='tree')await walk(null,next.oid,path);if(next?.type==='tree'||!next)continue;}
    if(!next){files.push({path,mode:null,blob:null,gitOid:null});continue;}
    if(next.mode==='160000'){files.push({path,mode:next.mode,blob:null,gitOid:next.oid});continue;}
    const data=await row(project,next.oid);if(data?.kind!=='blob'||!data.blob||data.blob_state!=='ready')throw new Problem(409,'source_incomplete','Changed blob is missing',{path});files.push({path,mode:next.mode,...(next.rawMode?{rawMode:next.rawMode}:{}),blob:data.blob,gitOid:next.oid});if(files.length>100000)throw new Problem(422,'source_file_budget','Changeset has too many changed paths');
   }
  }
  await walk(first?.tree??null,c.tree,'');files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const data=await raw(project,id),split=data.indexOf('\n\n');const metadata={rawSuffix:data.subarray(data.indexOf(10)+1).toString('base64'),headers:data.subarray(0,split).toString().split('\n').filter(line=>!line.startsWith('tree ')),message:c.message};const manifest={version:1,parents,files,metadata};const identity=hash('sha256',JSON.stringify(manifest));
  await sql`INSERT INTO weave_changesets(project,id,git_oid,parents,files,metadata) VALUES(${project},${identity},${id},${parents},${sql.json(files)},${sql.json(metadata)}) ON CONFLICT DO NOTHING`;
  if(files.length){const paths=[...new Set(files.map(f=>f.path as string))].map(path=>({project,version:1,path,git_oid:id}));await sql`INSERT INTO weave_source_paths ${sql(paths,'project','version','path','git_oid')} ON CONFLICT DO NOTHING`;}
  await sql`INSERT INTO weave_commit_graph(project,version,oid,tree,parents,message) VALUES(${project},1,${id},${c.tree},${c.parents},${c.message}) ON CONFLICT DO NOTHING`;return changeset(project,id);
 }
 async function derive(project:string,kind:unknown,version:unknown,ids:unknown){
  if(!['tree','generation','indexes'].includes(kind as string)||version!==1||!Array.isArray(ids)||!ids.length||ids.length>128||ids.some(id=>typeof id!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(id)))throw new Problem(400,'derived_options','Use tree, generation or indexes version 1 with 1–128 immutable changesets');
  const manifests=new Map<string,Awaited<ReturnType<typeof changeset>>>();
  const manifest=async(key:string)=>{if(!manifests.has(key))manifests.set(key,await changeset(project,key));return manifests.get(key)!;};
  const canonical=[];for(const id of ids)canonical.push((await manifest(id)).id);
  if(kind==='indexes'){
   const commits:string[]=[];
   for(const key of canonical){const m=await manifest(key),c=await commit(project,m.gitOid);if(!c)throw new Problem(409,'derived_tree_required','Rebuild compatibility trees before the graph index');commits.push(c.oid);
    await sql`INSERT INTO weave_commit_graph(project,version,oid,tree,parents,message) VALUES(${project},1,${c.oid},${c.tree},${c.parents},${c.message}) ON CONFLICT DO NOTHING`;
    const paths=[...new Set<string>(m.files.map((f:any)=>f.path as string))].map(path=>({project,version:1,path,git_oid:c.oid}));if(paths.length)await sql`INSERT INTO weave_source_paths ${sql(paths,'project','version','path','git_oid')} ON CONFLICT DO NOTHING`;
   }
   return await completeGraphBatch(sql,project,commits);
  }
  const engine=derivedData(sql,project);
  if(kind==='generation')return {results:await engine.batch<{generation:number}>({kind:'source-generation',version:1,dependencies:async key=>(await manifest(key)).parents,compute:async(_key,parents)=>({generation:1+Math.max(0,...parents.map(p=>p.generation))})},canonical)};
  type Node={change?:any;children:Map<string,Node>};
  return {results:await engine.batch<{tree:string;gitOid:string}>({kind:'source-tree',version:1,dependencies:async key=>(await manifest(key)).parents.slice(0,1),compute:async(key,parents)=>{
   const c=await manifest(key),root:Node={children:new Map()};
   for(const file of c.files){let node=root;for(const name of file.path.split('/')){if(!name||name==='.'||name==='..')throw new Problem(503,'changeset_corrupt','Invalid canonical path');if(!node.children.has(name))node.children.set(name,{children:new Map()});node=node.children.get(name)!;}node.change=file;}
   const written:RawObject[]=[];
   async function rebuild(base:string|null,node:Node):Promise<string>{
    const entries=new Map((base?await tree(project,base):[]).map(e=>[e.name,e]));
    for(const [name,child]of node.children){let previous=entries.get(name);if(child.change){const f=child.change;if(f.mode===null)entries.delete(name);else entries.set(name,{name,mode:f.mode,...(f.rawMode?{rawMode:f.rawMode}:{}),oid:f.gitOid,type:f.mode==='160000'?'commit':'blob'});previous=entries.get(name);}
     if(child.children.size&&!child.change?.mode){const next=await rebuild(previous?.type==='tree'?previous.oid:null,child);if(next===oid('tree',Buffer.alloc(0)))entries.delete(name);else entries.set(name,{name,mode:'40000',oid:next,type:'tree'});}
    }
    const sorted=[...entries.values()].sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.type==='tree'?'/':'')),Buffer.from(b.name+(b.type==='tree'?'/':''))));
    const data=Buffer.concat(sorted.map(e=>Buffer.concat([Buffer.from((e.rawMode??e.mode)+' '+e.name+'\0'),Buffer.from(e.oid,'hex')]))),id=oid('tree',data);written.push({oid:id,type:'tree',data});return id;
   }
   const rootTree=await rebuild(parents[0]?.tree??null,root),data=Buffer.concat([Buffer.from('tree '+rootTree+'\n'),c.metadata.rawSuffix?Buffer.from(c.metadata.rawSuffix,'base64'):Buffer.from(c.metadata.headers.join('\n')+'\n\n'+c.metadata.message)]);
   if(oid('commit',data)!==c.gitOid)throw new Problem(503,'changeset_corrupt','Rebuilt commit does not match its compatibility identity');written.push({oid:c.gitOid,type:'commit',data});
   const rows=written.map(v=>({project,oid:v.oid,kind:v.type,size:v.data.length,raw:v.data}));await sql`INSERT INTO weave_source_objects ${sql(rows,'project','oid','kind','size','raw')} ON CONFLICT DO NOTHING`;
   return {tree:rootTree,gitOid:c.gitOid};
  }},canonical)};
 }
 async function history(project:string,start:string,path:string,limit=20,cursor?:string){
  immutable(start);if(!Number.isInteger(limit)||limit<1||limit>50)throw new Problem(400,'limit','History limit is 1–50');
  const graph=commitGraph(sql,project,{commit:id=>commit(project,id)}),root=await graph.get(start);if(!root||root.generation===null)throw new Problem(409,'index_required','Complete the source commit index first');
  let offset=0;
  if(cursor){const [saved]=await sql`SELECT value FROM weave_derived WHERE project=${project} AND kind='source-path-cursor:v1' AND key=${cursor}`;if(!saved||saved.value.start!==start||saved.value.path!==path||!Number.isSafeInteger(saved.value.offset))throw new Problem(400,'history_cursor','Cursor does not match this immutable path query');offset=saved.value.offset;}
  const rows=await sql`SELECT g.* FROM weave_source_paths p JOIN weave_commit_graph g ON g.project=p.project AND g.version=p.version AND g.oid=p.git_oid WHERE p.project=${project} AND p.version=1 AND p.path=${path} AND g.generation IS NOT NULL AND g.first_depth<=${root.depth} ORDER BY g.first_depth DESC,g.oid DESC LIMIT 256 OFFSET ${offset}`;
  const commits:Commit[]=[];let scanned=0;
  for(const r of rows){scanned++;if(await graph.firstAncestry(r.oid,start)){commits.push({oid:r.oid,tree:r.tree,parents:r.parents,message:r.message});if(commits.length===limit)return {commits,next:r.parents[0]??null,cursor:null,scanned,order:'first-parent'};}}
  let nextCursor:string|null=null;
  if(rows.length===256){const value={start,path,offset:offset+scanned};nextCursor=hash('sha256',JSON.stringify(value));await sql`INSERT INTO weave_derived(project,kind,key,value) VALUES(${project},'source-path-cursor:v1',${nextCursor},${sql.json(value)}) ON CONFLICT DO NOTHING`;}
  return {commits,next:nextCursor?start:null,cursor:nextCursor,scanned,order:'first-parent'};
 }
 async function latestPath(project:string,start:string,path:string){const result=await history(project,start,path,1);if(!result.commits.length&&result.cursor)throw new Problem(422,'path_query_budget','Path candidates require another bounded history page');return result.commits[0]?.oid??start;}
 async function renameCandidates(project:string,id:string,parent:string,path:string){
  const current=await commit(project,id);if(current?.parents[0]!==parent)return [];
  const rows=await sql`SELECT f->>'path' AS path FROM weave_changesets c CROSS JOIN LATERAL jsonb_array_elements(c.files) f WHERE c.project=${project} AND c.git_oid=${id} AND f->>'mode' IS NULL ORDER BY f->>'path' LIMIT 33`;
  if(rows.length>32)throw new Problem(422,'rename_budget','Blame rename detection exceeds 32 deleted candidates');return rows.map(r=>r.path as string).filter(candidate=>candidate!==path);
 }
 async function rpc(project:string,input:any):Promise<Response>{
  if(input.op==='head'){const [p]=await sql`SELECT head FROM weave_projects WHERE id=${project}`;return Response.json({head:p.head});}
  if(input.op==='stat'){
   if(!Array.isArray(input.oids)||!input.oids.length||input.oids.length>2000)throw new Problem(400,'rpc_batch','Stat accepts 1–2,000 immutable object IDs');input.oids.forEach(immutable);
   const rows=await sql`SELECT oid,kind,size FROM weave_source_objects WHERE project=${project} AND oid=ANY(${input.oids})`;if(rows.length!==new Set(input.oids).size)throw new Problem(404,'object_missing','Metadata is incomplete');
   return Response.json({objects:rows.map(r=>({oid:r.oid,type:r.kind,size:Number(r.size)}))});
  }
  if(input.op!=='object')throw new Problem(400,'rpc_operation','Use head, stat or object');immutable(input.oid);const info=await row(project,input.oid);if(!info)throw new Problem(404,'object_missing','Source object is missing');
  const data=await raw(project,input.oid);return new Response(data,{headers:{'content-type':'application/octet-stream','content-length':String(data.length),'x-squali-type':info.kind,'x-squali-oid':input.oid,'cache-control':'private, no-store'}});
 }
 async function status(project:string){const [counts]=await sql`SELECT count(*) AS objects,COALESCE(sum(size),0) AS bytes FROM weave_source_objects WHERE project=${project}`;const [{count}]=await sql`SELECT count(*) FROM weave_changesets WHERE project=${project}`;const [p]=await sql`SELECT p.git_bridge_limited,e.manifest FROM weave_projects p LEFT JOIN weave_git_exports e ON e.project=p.id WHERE p.id=${project}`;return {gitCompatibility:{state:p.git_bridge_limited?'provider_limit':p.manifest?'exported':'not_exported'},objects:Number(counts.objects),bytes:Number(counts.bytes),changesets:Number(count),refs:await sql`SELECT name,oid FROM weave_source_refs WHERE project=${project} ORDER BY name`};}
 function artifacts(fallback:Artifacts):Artifacts{
  const exporter=exportBridge=sourceExporter(sql,fallback,raw,decodeTree);
  async function loadProject(name:string){const [p]=await sql`SELECT id,artifact,storage,main_ref,git_bridge_limited FROM weave_projects WHERE artifact=${name}`;return p?.storage==='source'?{id:p.id as string,artifact:name,storage:'source',main_ref:p.main_ref as string,git_bridge_limited:p.git_bridge_limited as boolean}:null;}
  const projectRecords=new Map<string,ReturnType<typeof loadProject>>();
  const project=(name:string)=>{if(!projectRecords.has(name))projectRecords.set(name,loadProject(name));return projectRecords.get(name)!;};
  function repo(name:string):Repository{
   const original=fallback.repo(name);
   return {
    async info(){const p=await project(name);return p?{name,remote:'https://squa.li/api/projects/'+p.id+'/git'}:original.info();},
    async head(ref?:string){const p=await project(name);if(!p)return original.head(ref);const [row]=await sql`SELECT oid FROM weave_source_refs WHERE project=${p.id} AND name=${ref??p.main_ref}`;return row?.oid??null;},
    async commit(id){const p=await project(name);return p?commit(p.id,id):original.commit(id);},
    async tree(id){const p=await project(name);return p?tree(p.id,id):original.tree(id);},
    async blob(id){const p=await project(name);return p?raw(p.id,id):original.blob(id);},
    async persist(id,values,delta){const p=await project(name);if(!p)return false;await objects(p.id,values);await sealSourceBatch(sql,p.id,[id],decodeCommit,decodeTree,delta?{objects:values,delta}:undefined);return true;},
    async push(ref,old,id,pack){const p=await project(name);if(!p)return original.push(ref,old,id,pack);await objects(p.id,unpackWrittenPack(pack));await sealBatch(p.id,[id]);await sql.begin(async tx=>{const [current]=await tx`SELECT oid FROM weave_source_refs WHERE project=${p.id} AND name=${ref} FOR UPDATE`;if(current?.oid===id)return;if((current?.oid??null)!==old)throw new Problem(409,'head_moved','The source ref changed');if(current){const result=await tx`UPDATE weave_source_refs SET oid=${id} WHERE project=${p.id} AND name=${ref} AND oid=${old} RETURNING name`;if(!result.length)throw new Problem(409,'head_moved','The source ref changed');}else {const result=await tx`INSERT INTO weave_source_refs(project,name,oid) VALUES(${p.id},${ref},${id}) ON CONFLICT DO NOTHING RETURNING name`;if(!result.length)throw new Problem(409,'head_moved','The source ref was created concurrently');}});},
    async receive(refs,stream){if(!await project(name))return original.receive(refs,stream);await stream.cancel();throw new Problem(409,'source_import','Use the resumable source object importer');},
    async git(request,suffix){const p=await project(name);return p?exporter.git(p,request,suffix):original.git(request,suffix);}
   };
  }
  return {repo,async create(name,branch){if(!await project(name))await fallback.create(name,branch);}};
 }
 return {caps,exportPrepare:(p:any,refs:unknown)=>exportBridge.prepareSeed(p,refs),exportConfirm:(p:any,refs:unknown)=>exportBridge.confirmSeed(p,refs),exportIndex:(p:any,manifest:unknown,ids:unknown)=>exportBridge.seedObjects(p,manifest,ids),artifacts,objects,seal,changeset,status,raw,tree,commit,missing,upload,uploadBlob,sealBatch,finish,derive,rpc,history,latestPath,renameCandidates};
}

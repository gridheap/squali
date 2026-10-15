import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {validRef} from './git-transfer.ts';
import {Problem,type Sql,type RawObject} from './types.ts';
import type {SourceBucket} from './source-store.ts';
type Chunk={hash:string;bytes:number};type File={bytes:number;chunks:Chunk[]};
type Manifest={version:1;packId:string;objects:number;defaultBranch:string;refs:{name:string;oid:string}[];pack:File;index:File};
const digest=(algorithm:string,data:Uint8Array|string)=>createHash(algorithm).update(data).digest('hex');
const key=(hash:string)=>'git-snapshots/v1/'+hash;
const partList=(m:Manifest)=>[...new Map([...m.pack.chunks,...m.index.chunks].map(c=>[c.hash,c])).values()];
function parse(value:any):Manifest{
 if(value?.version!==1||!/^[a-f0-9]{40}$/.test(value.packId??'')||!Number.isSafeInteger(value.objects)||value.objects<1||value.objects>500000||typeof value.defaultBranch!=='string'||!validRef('refs/heads/'+value.defaultBranch))throw new Problem(400,'snapshot_manifest','Invalid bounded Git snapshot');
 if(!Array.isArray(value.refs)||!value.refs.length||value.refs.length>5000||value.refs.some((r:any)=>!validRef(r?.name??'')||!/^[a-f0-9]{40}$/.test(r?.oid??''))||new Set(value.refs.map((r:any)=>r.name)).size!==value.refs.length||!value.refs.some((r:any)=>r.name==='refs/heads/'+value.defaultBranch))throw new Problem(400,'snapshot_refs','Supply the frozen original refs and default branch');
 for(const [name,max]of [['pack',512*1024**2],['index',16*1024**2]] as const){const f=value[name];if(!Number.isSafeInteger(f?.bytes)||f.bytes<32||f.bytes>max||!Array.isArray(f.chunks)||!f.chunks.length||f.chunks.length>66||f.chunks.some((c:any)=>!/^[a-f0-9]{64}$/.test(c?.hash??'')||!Number.isSafeInteger(c.bytes)||c.bytes<1||c.bytes>8*1024**2)||f.chunks.reduce((n:number,c:Chunk)=>n+c.bytes,0)!==f.bytes)throw new Problem(400,'snapshot_file','Invalid snapshot file or chunk bounds');}
 const m:Manifest={version:1,packId:value.packId,objects:value.objects,defaultBranch:value.defaultBranch,refs:value.refs.map((r:any)=>({name:r.name,oid:r.oid})).sort((a:any,b:any)=>a.name<b.name?-1:1),pack:{bytes:value.pack.bytes,chunks:value.pack.chunks.map((c:any)=>({hash:c.hash,bytes:c.bytes}))},index:{bytes:value.index.bytes,chunks:value.index.chunks.map((c:any)=>({hash:c.hash,bytes:c.bytes}))}};
 if(m.pack.chunks.length+m.index.chunks.length>68)throw new Problem(400,'snapshot_parts','At most 68 snapshot chunks');
 const sizes=new Map<string,number>();for(const c of [...m.pack.chunks,...m.index.chunks]){if(sizes.has(c.hash)&&sizes.get(c.hash)!==c.bytes)throw new Problem(400,'snapshot_part','Conflicting immutable chunk sizes');sizes.set(c.hash,c.bytes);}return m;
}
export function sourceSnapshots(sql:Sql,bucket:SourceBucket,reserve:(kind:'reads'|'writes',count?:number)=>Promise<void>,readObject:(project:string,oid:string)=>Promise<RawObject|null>){
 const saved=async(project:string)=>{const [s]=await sql`SELECT * FROM weave_git_snapshots WHERE project=${project}`;return s;};
 async function prepare(project:any,input:unknown){
  if(project.storage!=='source'||project.state!=='importing'&&!project.git_bridge_limited)throw new Problem(409,'snapshot_state','Snapshots are limited to source imports or provider-limited workspaces');
  const manifest=parse(input),identity=digest('sha256',JSON.stringify(manifest));
  const existing=await saved(project.id);
  if(existing&&existing.identity!==identity)throw new Problem(409,'snapshot_identity','Keep the existing immutable snapshot manifest');
  if(!existing){
  const refs=await sql`SELECT oid,kind FROM weave_source_objects WHERE project=${project.id} AND oid=ANY(${[...new Set(manifest.refs.map(r=>r.oid))]})`;
  if(manifest.refs.some(r=>!refs.some(o=>o.oid===r.oid&&(!r.name.startsWith('refs/heads/')||o.kind==='commit'))))throw new Problem(409,'snapshot_refs','Snapshot refs must name admitted source objects');
  if(project.state==='ready'){const current=await sql`SELECT name,oid FROM weave_source_refs WHERE project=${project.id} ORDER BY name`;if(JSON.stringify(current.map(r=>({name:r.name,oid:r.oid})))!==JSON.stringify(manifest.refs)||project.main_ref!=='refs/heads/'+manifest.defaultBranch)throw new Problem(409,'snapshot_refs','Snapshot must describe the frozen published refs');}
  }
  const [s]=await sql`INSERT INTO weave_git_snapshots(project,identity,manifest) VALUES(${project.id},${identity},${sql.json(manifest)}) ON CONFLICT(project) DO UPDATE SET project=EXCLUDED.project RETURNING *`;
  if(s.identity!==identity)throw new Problem(409,'snapshot_identity','Keep the existing immutable snapshot manifest');
  const parts=partList(manifest),ready=new Set((await sql`SELECT hash FROM weave_git_snapshot_parts WHERE hash=ANY(${parts.map(c=>c.hash)}) AND state='ready'`).map(r=>r.hash));
  return {identity,state:s.state,missing:parts.filter(c=>!ready.has(c.hash)).map(c=>c.hash)};
 }
 async function upload(project:string,hash:string,request:Request){
  if(!/^[a-f0-9]{64}$/.test(hash)||request.headers.get('content-type')!=='application/octet-stream')throw new Problem(400,'snapshot_part','Use a SHA-256 chunk and octet-stream body');
  const s=await saved(project),part=s&&partList(s.manifest).find(c=>c.hash===hash);if(!part)throw new Problem(404,'snapshot_part','Chunk is outside the frozen manifest');
  const reader=request.body?.getReader();if(!reader)throw new Problem(400,'snapshot_part','Missing chunk');const pieces:Uint8Array[]=[];let size=0;
  while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>part.bytes){await reader.cancel();throw new Problem(400,'snapshot_hash','Chunk exceeds its immutable size');}pieces.push(r.value);}
  const bytes=Buffer.concat(pieces);if(size!==part.bytes||digest('sha256',bytes)!==hash)throw new Problem(400,'snapshot_hash','Chunk content does not match its identity');
  const [claim]=await sql`INSERT INTO weave_git_snapshot_parts(hash,size) VALUES(${hash},${size}) ON CONFLICT DO NOTHING RETURNING hash`;
  if(!claim){const [row]=await sql`SELECT * FROM weave_git_snapshot_parts WHERE hash=${hash}`;if(Number(row.size)!==size)throw new Problem(409,'snapshot_hash','Stored chunk size differs');if(row.state==='ready')return {ready:true,reused:true};
   await reserve('reads');const found=await bucket.head(key(hash));if(found){if(found.size!==size||found.customMetadata?.sha256!==hash)throw new Problem(503,'snapshot_corrupt','Stored chunk identity differs');await sql`UPDATE weave_git_snapshot_parts SET state='ready' WHERE hash=${hash}`;return {ready:true,reused:true};}
   const retry=await sql`UPDATE weave_git_snapshot_parts SET attempts=attempts+1,lease_until=now()+interval '5 minutes' WHERE hash=${hash} AND state='uploading' AND lease_until<now() AND attempts<2 RETURNING hash`;if(!retry.length)throw new Problem(503,'snapshot_pending','A chunk upload is active or its two-attempt ceiling is exhausted');
  }
  await reserve('writes');try{await bucket.put(key(hash),bytes,{customMetadata:{sha256:hash},httpMetadata:{contentType:'application/octet-stream'}});}catch{throw new Problem(503,'snapshot_upload','Chunk acknowledgement is unknown; resume reconciles the stored identity');}
  await sql`UPDATE weave_git_snapshot_parts SET state='ready' WHERE hash=${hash}`;return {ready:true,reused:false};
 }
 async function index(project:string,ids:unknown){
  const s=await saved(project);if(!s||!Array.isArray(ids)||!ids.length||ids.length>2000||ids.some(v=>typeof v!=='string'||!/^[a-f0-9]{40}$/.test(v)))throw new Problem(400,'snapshot_index','Index 1–2,000 source object identities');
  if(s.state==='ready')return {ready:true};
  const found=await sql`SELECT oid FROM weave_source_objects WHERE project=${project} AND oid=ANY(${ids})`;if(found.length!==new Set(ids).size)throw new Problem(409,'snapshot_index','Snapshot contains an unknown source object');
  await sql`INSERT INTO weave_git_objects ${sql(found.map(r=>({project,oid:r.oid})),'project','oid')} ON CONFLICT DO NOTHING`;return {indexed:found.length};
 }
 async function chunk(part:Chunk){const value=await bucket.get(key(part.hash));if(!value)throw new Problem(503,'snapshot_missing','Snapshot chunk is missing');const bytes=Buffer.from(await value.arrayBuffer());if(bytes.length!==part.bytes||digest('sha256',bytes)!==part.hash)throw new Problem(503,'snapshot_corrupt','Snapshot chunk failed its identity check');return bytes;}
 async function complete(project:string){
  const s=await saved(project);if(!s)throw new Problem(409,'snapshot_missing','Prepare a frozen snapshot first');if(s.state==='ready')return {state:'ready',reused:true};const m=s.manifest as Manifest,parts=partList(m);
  const [{count}]=await sql`SELECT count(*) FROM weave_source_objects o JOIN weave_git_objects g ON g.project=o.project AND g.oid=o.oid WHERE o.project=${project}`;
  const [{count:objects}]=await sql`SELECT count(*) FROM weave_source_objects WHERE project=${project}`;
  if(Number(count)!==m.objects||Number(objects)!==m.objects)throw new Problem(409,'snapshot_index','Index every imported source object before activation');
  const ready=await sql`SELECT hash FROM weave_git_snapshot_parts WHERE hash=ANY(${parts.map(p=>p.hash)}) AND state='ready'`;if(ready.length!==parts.length)throw new Problem(409,'snapshot_incomplete','Snapshot chunks are incomplete');
  const lease=await sql`UPDATE weave_git_snapshots SET lease_until=now()+interval '10 minutes',checks=checks+1 WHERE project=${project} AND state='preparing' AND (lease_until IS NULL OR lease_until<now()) AND checks<2 RETURNING project`;if(!lease.length)throw new Problem(409,'snapshot_check','Snapshot validation is active or its bounded attempts are exhausted');
  try{
   // Reserve all GETs before the stream starts, so no delayed pull needs SQL.
   await reserve('reads',m.pack.chunks.length+m.index.chunks.length);
   const hash=createHash('sha1');let tail=Buffer.alloc(0),header=Buffer.alloc(0);
   for(const part of m.pack.chunks){const bytes=await chunk(part);if(header.length<12)header=Buffer.concat([header,bytes]).subarray(0,12);const joined=Buffer.concat([tail,bytes]);if(joined.length>20){hash.update(joined.subarray(0,-20));tail=joined.subarray(-20);}else tail=joined;}
   if(header.subarray(0,4).toString()!=='PACK'||header.readUInt32BE(4)!==2||header.readUInt32BE(8)!==m.objects||tail.toString('hex')!==m.packId||hash.digest('hex')!==m.packId)throw new Problem(409,'snapshot_pack','Git pack checksum, header or object count differs');
   const indexParts:Buffer[]=[];for(const part of m.index.chunks)indexParts.push(await chunk(part));const bytes=Buffer.concat(indexParts);
   if(bytes.length<1072||bytes.readUInt32BE(0)!==0xff744f63||bytes.readUInt32BE(4)!==2||bytes.readUInt32BE(1028)!==m.objects||bytes.subarray(-40,-20).toString('hex')!==m.packId||digest('sha1',bytes.subarray(0,-20))!==bytes.subarray(-20).toString('hex'))throw new Problem(409,'snapshot_index','Git index checksum or object count differs');
   // Packs are below 512 MiB, so v2 indexes need no 64-bit offset table.
   if(bytes.length!==1072+m.objects*28)throw new Problem(409,'snapshot_index','Git index structure differs');
   const fanout=new Uint32Array(256);let previous='';
   for(let at=0;at<m.objects;at+=8192){
    const ids:string[]=[];
    for(let i=at;i<Math.min(m.objects,at+8192);i++){
     const oid=bytes.subarray(1032+i*20,1052+i*20).toString('hex'),offset=bytes.readUInt32BE(1032+m.objects*24+i*4);
     if(oid<=previous||offset<12||offset>=m.pack.bytes-20)throw new Problem(409,'snapshot_index','Git index order or offset differs');
     previous=oid;fanout[bytes[1032+i*20]]++;ids.push(oid);
    }
    const found=await sql`SELECT oid FROM weave_source_objects WHERE project=${project} AND oid=ANY(${ids})`;
    if(found.length!==ids.length)throw new Problem(409,'snapshot_index','Git pack membership differs from canonical source');
   }
   let total=0;for(let i=0;i<256;i++){total+=fanout[i];if(bytes.readUInt32BE(8+i*4)!==total)throw new Problem(409,'snapshot_index','Git index fanout differs');}
   await sql`UPDATE weave_git_snapshots SET state='ready',lease_until=NULL WHERE project=${project}`;return {state:'ready',reused:false};
  }catch(error){await sql`UPDATE weave_git_snapshots SET lease_until=NULL WHERE project=${project}`;throw error;}
 }
 async function git(project:{id:string;main_ref:string},request:Request,suffix:string):Promise<Response|null>{
  const s=await saved(project.id);if(!s||s.state!=='ready')return null;const m=s.manifest as Manifest,path=suffix.split('?')[0];
  if(request.method!=='GET')throw new Problem(403,'read_only_git','Snapshot Git access is read-only');
  const headers:Record<string,string>={'content-type':'text/plain; charset=utf-8','cache-control':'private, no-store'};
  if(path==='/HEAD')return new Response('ref: '+project.main_ref+'\n',{headers});
  if(path==='/info/refs'){const refs=await sql`SELECT name,oid FROM weave_source_refs WHERE project=${project.id} ORDER BY name`;return new Response(refs.map(r=>r.oid+'\t'+r.name+'\n').join(''),{headers});}
  if(path==='/objects/info/packs')return new Response('P pack-'+m.packId+'.pack\n\n',{headers});
  const file=path==='/objects/pack/pack-'+m.packId+'.pack'?m.pack:path==='/objects/pack/pack-'+m.packId+'.idx'?m.index:null;
  if(file){
   let start=0,end=file.bytes-1;const range=request.headers.get('range');if(range){const match=range.match(/^bytes=(\d+)-(\d*)$/);if(!match)throw new Problem(416,'snapshot_range','Use one bounded byte range');start=Number(match[1]);end=match[2]?Number(match[2]):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.bytes)throw new Problem(416,'snapshot_range','Range is outside the immutable file');end=Math.min(end,file.bytes-1);}
   let at=0;const slices:{part:Chunk;from:number;to:number}[]=[];for(const part of file.chunks){const next=at+part.bytes;if(next>start&&at<=end)slices.push({part,from:Math.max(0,start-at),to:Math.min(part.bytes,end-at+1)});at=next;}
   await reserve('reads',slices.length);let cursor=0;
   const body=new ReadableStream<Uint8Array>({async pull(controller){if(cursor===slices.length){controller.close();return;}try{const item=slices[cursor++],bytes=await chunk(item.part);controller.enqueue(bytes.subarray(item.from,item.to));}catch(error){controller.error(error);}}});
   return new Response(body,{status:range?206:200,headers:{...headers,'content-type':'application/octet-stream','content-length':String(end-start+1),'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${file.bytes}`}:{})}});
  }
  const match=path.match(/^\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/);
  if(match){const oid=match[1]+match[2],[packed]=await sql`SELECT oid FROM weave_git_objects WHERE project=${project.id} AND oid=${oid}`;if(packed)return new Response('Packed object\n',{status:404,headers});const value=await readObject(project.id,oid);if(!value)return new Response('Missing object\n',{status:404,headers});const data=deflateSync(Buffer.concat([Buffer.from(value.type+' '+value.data.length+'\0'),Buffer.from(value.data)]));return new Response(data,{headers:{...headers,'content-type':'application/octet-stream','content-length':String(data.length)}});}
  return new Response('Not found\n',{status:404,headers});
 }
 return {prepare,upload,index,complete,git};
}

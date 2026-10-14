import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import type {Repository,TreeEntry,Patch} from './types.ts';
import {Problem,ZERO} from './types.ts';
export const sha256=(s:string)=>createHash('sha256').update(s).digest('hex');
const objectId=(type:string,data:Uint8Array)=>createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
export const blobId=(content:string)=>objectId('blob',Buffer.from(content));
// Internal references come from validated immutable proposals, never public patch input.
export type BuildPatch=Patch|{path:string;oid:string;bytes:number;mode?:'100644'|'100755'};
export const pkt=(s:string)=>Buffer.concat([Buffer.from((Buffer.byteLength(s)+4).toString(16).padStart(4,'0')),Buffer.from(s)]);
export function readPackets(data:Uint8Array){
 const b=Buffer.from(data);const out:string[]=[];let at=0;
 while(at+4<=b.length){const n=parseInt(b.subarray(at,at+4).toString(),16);at+=4;if(n===0)continue;if(!Number.isFinite(n)||n<4||at+n-4>b.length)throw new Problem(502,'git_protocol','Invalid Git packet response');out.push(b.subarray(at,at+n-4).toString());at+=n-4;}
 return out;
}
export function validPath(path:unknown):asserts path is string {
 if(typeof path!=='string'||path.length>512||!path||path.includes('\\')||/[\x00-\x1f\x7f]/.test(path)||path.split('/').some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.git')||path.split('/').length>20)throw new Problem(400,'invalid_path','Use a relative file path, without .git, traversal, or empty components.');
}
export class GitSession {
 private trees=new Map<string,Promise<TreeEntry[]>>();
 private blobs=new Map<string,Promise<Uint8Array>>();
 private commits=new Map<string,Promise<Awaited<ReturnType<Repository['commit']>>>>();
 constructor(public repo:Repository){}
 tree(oid:string){if(!this.trees.has(oid))this.trees.set(oid,this.repo.tree(oid));return this.trees.get(oid)!;}
 commit(oid:string){if(!/^[a-f0-9]{40}$/.test(oid))throw new Problem(400,'invalid_ref','An immutable 40-character commit ID is required.');if(!this.commits.has(oid))this.commits.set(oid,this.repo.commit(oid));return this.commits.get(oid)!;}
 blob(oid:string){if(!this.blobs.has(oid))this.blobs.set(oid,this.repo.blob(oid));return this.blobs.get(oid)!;}
 async entry(oid:string,path:string):Promise<TreeEntry|null>{
  validPath(path);if(oid===ZERO)return null;const c=await this.commit(oid);if(!c)throw new Problem(404,'commit_missing','Commit does not exist');let tree=c.tree;const parts=path.split('/');
  for(let i=0;i<parts.length;i++){const e=(await this.tree(tree)).find(e=>e.name===parts[i]);if(!e)return null;if(i===parts.length-1)return e;if(e.type!=='tree')return null;tree=e.oid;}return null;
 }
 async file(oid:string,path:string){const e=await this.entry(oid,path);if(!e)return null;if(e.type!=='blob'||!['100644','100755'].includes(e.mode))throw new Problem(422,'unsupported_file','Only regular files are editable through this API');const bytes=await this.blob(e.oid);if(bytes.length>256*1024)throw new Problem(413,'file_limit','File exceeds the editing API limit');try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw new Error();return text;}catch{throw new Problem(422,'binary_file','The editing API accepts UTF-8 text only');}}
 async build(parent:string|null,files:BuildPatch[],message:string,author:string,timestamp:number,extraParents:string[]=[]){
  const objects=new Map<string,{type:string;data:Buffer}>();
  const add=(type:string,data:Buffer)=>{const id=objectId(type,data);objects.set(id,{type,data});return id;};
  const root=parent?(await this.commit(parent))?.tree:null;if(parent&&!root)throw new Problem(404,'commit_missing','Base commit does not exist');
  type Node={files:Map<string,BuildPatch>;dirs:Map<string,Node>};const changes:Node={files:new Map(),dirs:new Map()};
  for(const f of files){validPath(f.path);let node=changes;const parts=f.path.split('/');for(const p of parts.slice(0,-1)){if(!node.dirs.has(p))node.dirs.set(p,{files:new Map(),dirs:new Map()});node=node.dirs.get(p)!;}node.files.set(parts.at(-1)!,f);}
  const rewrite=async(old:string|null,node:Node):Promise<string>=>{
   const entries=new Map((old?await this.tree(old):[]).map(e=>[e.name,e]));
   for(const [name,sub] of node.dirs){const previous=entries.get(name);if(previous&&previous.type!=='tree')throw new Problem(409,'path_collision','A file blocks a directory path');const oid=await rewrite(previous?.oid??null,sub);const body=objects.get(oid)?.data;if(body?.length===0)entries.delete(name);else entries.set(name,{name,mode:'40000',type:'tree',oid});}
   for(const [name,file] of node.files){const previous=entries.get(name);if(node.dirs.has(name)||previous?.type==='tree')throw new Problem(409,'path_collision','File/directory replacement must be explicit');if(previous&&!['100644','100755'].includes(previous.mode))throw new Problem(422,'unsupported_file','Cannot overwrite a symlink or submodule');if('content' in file&&file.content===null)entries.delete(name);else {if('oid' in file&&(!/^[a-f0-9]{40}$/.test(file.oid)||!Number.isSafeInteger(file.bytes)||file.bytes<0))throw new Problem(500,'blob_reference','Invalid internal blob reference');entries.set(name,{name,mode:file.mode??previous?.mode??'100644',type:'blob',oid:'oid' in file?file.oid:add('blob',Buffer.from(file.content!))});}}
   const sorted=[...entries.values()].sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.type==='tree'?'/':'')),Buffer.from(b.name+(b.type==='tree'?'/':''))));
   const oid=add('tree',Buffer.concat(sorted.map(e=>Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.oid,'hex')]))));this.trees.set(oid,Promise.resolve(sorted));return oid;
  };
  const tree=await rewrite(root??null,changes);const parents=[...(parent?[parent]:[]),...extraParents].filter((v,i,a)=>a.indexOf(v)===i);
  const safeAuthor=author.replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,80);
  const oid=add('commit',Buffer.from(`tree ${tree}\n${parents.map(p=>`parent ${p}\n`).join('')}author ${safeAuthor} <agent@squali.invalid> ${timestamp} +0000\ncommitter Squali <squali@squali.invalid> ${timestamp} +0000\n\n${message}\n`));
  this.commits.set(oid,Promise.resolve({oid,tree,parents,message:message+'\n'}));
  const header=Buffer.alloc(12);header.write('PACK');header.writeUInt32BE(2,4);header.writeUInt32BE(objects.size,8);const buffers=[header];
  for(const {type,data} of objects.values()){let size=data.length;let byte=({commit:1,tree:2,blob:3}[type]!)<<4|(size&15);size=Math.floor(size/16);const h=[];while(size){h.push(byte|128);byte=size&127;size=Math.floor(size/128);}h.push(byte);buffers.push(Buffer.from(h),deflateSync(data,{level:1}));}
  const payload=Buffer.concat(buffers);const pack=Buffer.concat([payload,createHash('sha1').update(payload).digest()]);
  return {oid,tree,pack,objects:objects.size,bytes:pack.length,rawObjects:[...objects].map(([oid,value])=>({oid,type:value.type as import('./types.ts').RawObject['type'],data:value.data}))};
 }
}
export async function pushHttp(remote:string,token:string,ref:string,old:string|null,oid:string,pack:Uint8Array){
 const command=pkt(`${old??ZERO} ${oid} ${ref}\0report-status\n`);
 const response=await fetch(remote.replace(/\/$/,'')+'/git-receive-pack',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/x-git-receive-pack-request',accept:'application/x-git-receive-pack-result'},body:Buffer.concat([command,Buffer.from('0000'),Buffer.from(pack)]),signal:AbortSignal.timeout(20000),redirect:'manual'});
 if(!response.ok)throw new Problem(502,'git_push_failed',`Git transport returned ${response.status}`);
 const lines=readPackets(new Uint8Array(await response.arrayBuffer()));
 if(!lines.includes('unpack ok\n')||!lines.includes(`ok ${ref}\n`))throw new Problem(409,'head_moved','Git rejected the expected head. Refresh the publication preview.',{status:lines.filter(x=>!x.includes('token')).slice(0,4)});
}

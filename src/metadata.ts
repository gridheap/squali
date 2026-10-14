import {diffIndices,diff3Merge} from 'node-diff3';
import {commitGraph} from './graph.ts';
import {GitSession,sha256,validPath} from './git.ts';
import {Problem,ZERO} from './types.ts';
import type {Commit,Repository,Sql,TreeEntry,Patch} from './types.ts';

/** Versioned derived answers. No client depends on the representation in this table. */
export function metadataService(sql:Sql,project:string,repo:Repository){
 const graph=commitGraph(sql,project,repo);
 const g=new GitSession(repo);const commits=new Map<string,Commit>();let trees=0,lineWork=0;
 const ref=(oid:unknown)=>{if(typeof oid!=='string'||!/^[a-f0-9]{40}$/.test(oid))throw new Problem(400,'invalid_ref','Use an immutable commit ID');return oid;};
 async function derive(kind:string,key:string,compute:()=>Promise<any>):Promise<any>{
  const [cached]=await sql`SELECT value FROM weave_derived WHERE project=${project} AND kind=${kind+'-v1'} AND key=${key}`;if(cached)return cached.value;
  const value=await compute();await sql`INSERT INTO weave_derived(project,kind,key,value) VALUES(${project},${kind+'-v1'},${key},${sql.json(value)}) ON CONFLICT DO NOTHING`;return value;
 }
 async function commit(oid:string){ref(oid);if(commits.has(oid))return commits.get(oid)!;if(commits.size>=256)throw new Problem(422,'query_budget','This query exceeds 256 commits; narrow the range or page through history');const value:Commit=await derive('commit',oid,async()=>{const c=await g.commit(oid);if(!c)throw new Problem(404,'commit_missing','Commit not found');return c;});commits.set(oid,value);return value;}
 async function tree(oid:string|null){if(!oid)return [];if(++trees>256)throw new Problem(422,'query_budget','This diff exceeds 256 changed trees; select a narrower path');return g.tree(oid);}
 async function diff(from:string,to:string,path?:string){ref(from);ref(to);if(path)validPath(path);return derive('diff',from+':'+to+':'+sha256(path??''),async()=>{
  const files:any[]=[];let bytes=0;
  async function add(p:string,before:TreeEntry|undefined,after:TreeEntry|undefined){if(files.length>=64)throw new Problem(422,'query_budget','At most 64 changed files per diff; select a path');let a:string|null=null,b:string|null=null,binary=false;
   try{a=from===ZERO?null:await g.file(from,p);b=to===ZERO?null:await g.file(to,p);}catch(e){if(e instanceof Problem&&[413,422].includes(e.status))binary=true;else throw e;}
   bytes+=Buffer.byteLength(a??'')+Buffer.byteLength(b??'');if(bytes>1024*1024)throw new Problem(413,'diff_limit','Text diff exceeds 1 MiB');files.push({path:p,before:a,after:b,beforeOid:before?.oid??null,afterOid:after?.oid??null,beforeMode:before?.mode??null,mode:after?.mode??null,binary});
  }
  async function walk(a:string|null,b:string|null,prefix:string){if(a===b)return;const old=new Map((await tree(a)).map(e=>[e.name,e])),next=new Map((await tree(b)).map(e=>[e.name,e]));for(const name of [...new Set([...old.keys(),...next.keys()])].sort()){const x=old.get(name),y=next.get(name),p=prefix?prefix+'/'+name:name;if(x?.oid===y?.oid&&x?.mode===y?.mode)continue;if(x?.type==='tree'||y?.type==='tree'){if(x&&x.type!=='tree'||y&&y.type!=='tree')throw new Problem(422,'path_collision','File/directory type changes require a narrower explicit migration');await walk(x?.oid??null,y?.oid??null,p);}else await add(p,x,y);}}
  if(path){const a=from===ZERO?null:await g.entry(from,path),b=to===ZERO?null:await g.entry(to,path);if(a?.type==='tree'||b?.type==='tree')await walk(a?.oid??null,b?.oid??null,path);else if(a?.oid!==b?.oid||a?.mode!==b?.mode)await add(path,a??undefined,b??undefined);}
  else await walk(from===ZERO?null:(await commit(from)).tree,to===ZERO?null:(await commit(to)).tree,'');
  return {from,to,files};
 });}
 async function history(start:string,path:string,limit=20){ref(start);validPath(path);if(!Number.isInteger(limit)||limit<1||limit>50)throw new Problem(400,'limit','History limit is 1–50');const result:Commit[]=[];let current:string|undefined=start,scanned=0;
  while(current&&result.length<limit&&scanned<64){current=await graph.unchanged(current);const c=await commit(current);const delta=await derive('path-delta',current+':'+sha256(path),async()=>{const now=await g.entry(c.oid,path),old=c.parents[0]?await g.entry(c.parents[0],path):null;return {changed:now?.oid!==old?.oid||now?.mode!==old?.mode};});if(delta.changed)result.push(c);current=c.parents[0];scanned++;}
  return {commits:result,next:current??null,scanned,order:'first-parent'};
 }
 type Line={text:string;commit:string;originalLine:number};
 async function blame(oid:string,path:string):Promise<{ref:string;path:string;lines:Line[]}>{ref(oid);validPath(path);return derive('blame',oid+':'+sha256(path),async()=>{
  const stable=await graph.unchanged(oid);if(stable!==oid)return {ref:oid,path,lines:(await blame(stable,path)).lines};
  const c=await commit(oid),content=await g.file(oid,path);if(content===null)throw new Problem(404,'file_missing','File not found');const text=content.split('\n');if(text.at(-1)==='')text.pop();if(text.length>2000)throw new Problem(413,'blame_limit','Blame accepts at most 2,000 lines');const lines:Line[]=text.map((text,i)=>({text,commit:oid,originalLine:i+1}));
  for(const parent of c.parents){const entry=await g.entry(parent,path);if(!entry)continue;const previous=await blame(parent,path);const old=previous.lines.map(l=>l.text);lineWork+=old.length*text.length;if(lineWork>4000000)throw new Problem(422,'query_budget','Blame comparison budget exceeded; choose a smaller file');const hunks=diffIndices(old,text);let a=0,b=0;for(const h of [...hunks,{buffer1:[old.length,0],buffer2:[text.length,0]}]){while(a<h.buffer1[0]&&b<h.buffer2[0]){if(lines[b].commit===oid)lines[b]={...previous.lines[a]};a++;b++;}a=h.buffer1[0]+h.buffer1[1];b=h.buffer2[0]+h.buffer2[1];}}
  return {ref:oid,path,lines};
 });}
 async function revert(target:string,head:string):Promise<Patch[]>{const c=await commit(ref(target));const changes=await diff(c.parents[0]??ZERO,target);const files:Patch[]=[];for(const file of changes.files){if(file.binary)throw new Problem(422,'binary_file','Binary reverts require native tooling');const current=await g.entry(head,file.path);if((current?.oid??null)!==file.afterOid||(current?.mode??null)!==file.mode)throw new Problem(409,'revert_conflict','Later edits conflict with the revert',{path:file.path});files.push({path:file.path,content:file.before,...(file.beforeMode?{mode:file.beforeMode}:{})});}return files;}
 async function rebase(source:string,onto:string,parent?:number,resolutions:Patch[]=[]){
  const c=await commit(ref(source));await commit(ref(onto));
  if(parent!==undefined&&(!Number.isInteger(parent)||parent<1||parent>c.parents.length)||c.parents.length>1&&parent===undefined)throw new Problem(400,'rebase_parent','Select an existing parent number for a merge commit');
  const parentNumber=c.parents.length?(parent??1):0,base=c.parents[parentNumber-1]??ZERO;
  const delta=await diff(base,source),resolved=new Map(resolutions.map(f=>[f.path,f])),conflictPaths=new Set<string>(),conflicts:any[]=[],files:Patch[]=[];let work=0,bytes=0,comparedBytes=0;
  const choose=<T>(before:T,target:T,incoming:T):{value:T;conflict:boolean}=>target===before?{value:incoming,conflict:false}:incoming===before||target===incoming?{value:target,conflict:false}:{value:incoming,conflict:true};
  for(const f of delta.files){
   if(f.binary)throw new Problem(422,'binary_file','Rebase supports regular UTF-8 files within the editing limits');
   const entry=await g.entry(onto,f.path);
   if(entry&&(entry.type!=='blob'||!['100644','100755'].includes(entry.mode)))throw new Problem(422,'rebase_object','The target path is not a regular file',{path:f.path});
   const parts=f.path.split('/');for(let i=1;i<parts.length;i++){const ancestor=await g.entry(onto,parts.slice(0,i).join('/'));if(ancestor&&ancestor.type!=='tree')throw new Problem(422,'path_collision','A target file blocks this directory path',{path:f.path});}
   const target=await g.file(onto,f.path);comparedBytes+=Buffer.byteLength(f.before??'')+Buffer.byteLength(target??'')+Buffer.byteLength(f.after??'');if(comparedBytes>2*1024*1024)throw new Problem(413,'rebase_size','Rebase comparisons and conflict details exceed 2 MiB');
   const text=choose<string|null>(f.before,target,f.after),mode=choose<string|null>(f.beforeMode,entry?.mode??null,f.mode);
   if(text.conflict&&f.before!==null&&target!==null&&f.after!==null){
    const a=target.split('\n'),o=f.before.split('\n'),b=f.after.split('\n');work+=a.length+o.length+b.length;
    if(Math.max(a.length,o.length,b.length)<=2000&&work<=12000){
     const output:string[]=[];let conflict=false;
     for(const region of diff3Merge(a,o,b,{excludeFalseConflicts:true})){if(region.ok)output.push(...region.ok);else if(region.conflict){const r=region.conflict;if(r.a.length===r.o.length&&r.b.length===r.o.length){for(let i=0;i<r.o.length;i++){const line=choose(r.o[i],r.a[i],r.b[i]);if(line.conflict)conflict=true;output.push(line.value);}}else conflict=true;}}
     if(!conflict){text.value=output.join('\n');text.conflict=false;}
    }
   }
   let patch:Patch;
   if(text.conflict||mode.conflict){
    conflictPaths.add(f.path);const resolution=resolved.get(f.path);
    if(!resolution){conflicts.push({path:f.path,base:f.before,target,incoming:f.after,baseMode:f.beforeMode,targetMode:entry?.mode??null,incomingMode:f.mode,reason:'Resolve overlapping content, deletion or mode changes'});continue;}
    patch={...resolution,...(resolution.content!==null?{mode:resolution.mode??entry?.mode as Patch['mode']??f.mode??'100644'}:{})};
   }else patch={path:f.path,content:text.value,...(text.value!==null?{mode:mode.value as Patch['mode']}:{})};
   bytes+=Buffer.byteLength(patch.content??'');if(Buffer.byteLength(patch.content??'')>256*1024||bytes>1024*1024)throw new Problem(413,'rebase_size','Rebased text exceeds the editing limits');files.push(patch);
  }
  if(resolutions.some(f=>!conflictPaths.has(f.path)))throw new Problem(400,'rebase_resolution','Resolutions may only name conflicted paths');
  if(conflicts.length)throw new Problem(409,'rebase_conflict','Resolve these paths and repeat with the same immutable source and target',{commit:source,onto,base,conflicts});
  return {files,parent:parentNumber,base};
 }
 async function search(oid:string,query:string,path='',cursor?:string){ref(oid);if(path)validPath(path);if(typeof query!=='string'||query.length>128)throw new Problem(400,'search','Search text is limited to 128 characters');
  const identity={ref:oid,query,path};let stack:{oid:string;path:string;offset:number}[];
  if(cursor){if(!/^[a-f0-9]{64}$/.test(cursor))throw new Problem(400,'cursor','Invalid search cursor');const [row]=await sql`SELECT value FROM weave_derived WHERE project=${project} AND kind='search-cursor-v1' AND key=${cursor}`;if(!row||row.value.identity.ref!==oid||row.value.identity.query!==query||row.value.identity.path!==path)throw new Problem(400,'cursor','Search cursor belongs to another query');stack=row.value.stack;}
  else {const root=path?await g.entry(oid,path):null;if(path&&root?.type!=='tree')throw new Problem(400,'search_path','Search within a directory');stack=[{oid:root?.oid??(await commit(oid)).tree,path,offset:0}];}
  const matches=[];const readTrees=new Set<string>();let visited=0;while(stack.length&&matches.length<50&&visited<2000){const frame=stack.at(-1)!;if(!readTrees.has(frame.oid)&&readTrees.size>=64)break;readTrees.add(frame.oid);const entries=await g.tree(frame.oid);if(frame.offset>=entries.length){stack.pop();continue;}const entry=entries[frame.offset++];visited++;const current=frame.path?frame.path+'/'+entry.name:entry.name;validPath(current);if(entry.type==='tree'){if(stack.length>=20)throw new Problem(422,'search_depth','Search directory depth exceeded');stack.push({oid:entry.oid,path:current,offset:0});}else if(current.toLowerCase().includes(query.toLowerCase()))matches.push({path:current,oid:entry.oid,mode:entry.mode});}
  let next:string|null=null;if(stack.length){const value={identity,stack};next=sha256(JSON.stringify(value));await sql`INSERT INTO weave_derived(project,kind,key,value) VALUES(${project},'search-cursor-v1',${next},${sql.json(value)}) ON CONFLICT DO NOTHING`;}
  return {ref:oid,matches,next,visited};
 }
 return {commit,ancestry:graph.ancestry,mergeBase:graph.mergeBase,diff,history,blame,bisect:graph.bisect,revert,rebase,search,index:graph.build,indexStatus:graph.status,indexCommits:graph.ingest};
}

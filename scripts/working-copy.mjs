#!/usr/bin/env node
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,lstat,chmod,unlink,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
const [command,...args]=process.argv.slice(2);
const base=(process.env.SQUALI_URL??'http://127.0.0.1:8787').replace(/\/$/,'');
const token=process.env.SQUALI_TOKEN;if(!token)throw Error('Set SQUALI_TOKEN; credentials are never stored in the working copy.');
const cacheRoot=resolve(process.env.SQUALI_CACHE_DIR??'.squali-cache');const CACHE_LIMIT=64*1024*1024;
const hash=v=>createHash('sha256').update(v).digest('hex');
const oid=v=>createHash('sha1').update(Buffer.from(`blob ${v.length}\0`)).update(v).digest('hex');
const safe=p=>{if(typeof p!=='string'||!p||p.startsWith('/')||p.includes('\\')||p.split('/').some(v=>!v||v==='.'||v==='..'||v.toLowerCase()==='.git'||v==='.squali')||/[\x00-\x1f]/.test(p))throw Error('Unsafe workspace path');return p;};
async function request(path,body){const response=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.message??'Request failed'),{status:response.status});return value;}
const counters={networkObjects:0,cacheHits:0};let project,scope,allowedPaths;
async function authorize(pid){safe(pid);project=pid;await request('/projects/'+encodeURIComponent(project));const session=await request('/session');allowedPaths=session.principal.paths;scope=hash(base+'\0'+project+'\0'+JSON.stringify(allowedPaths??null));await mkdir(cacheRoot,{recursive:true,mode:0o700});}
async function evict(extra){const files=[];let bytes=0;for(const name of await readdir(cacheRoot)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const info=await lstat(join(cacheRoot,name));if(!info.isFile())throw Error('Cache must contain regular files');bytes+=info.size;files.push({name,...info});}files.sort((a,b)=>a.mtimeMs-b.mtimeMs);for(const file of files){if(bytes+extra<=CACHE_LIMIT)break;await unlink(join(cacheRoot,file.name));bytes-=file.size;}}
async function objects(wanted){const result=new Map();const missing=[];
 for(const object of wanted){const key=object.type+':'+object.oid;const path=join(cacheRoot,hash(scope+key)+'.json');try{const file=JSON.parse(await readFile(path,'utf8'));if(file.checksum!==hash(JSON.stringify(file.object))||file.object.oid!==object.oid||file.object.type!==object.type)throw Error('Corrupt cache');result.set(key,file.object.value);counters.cacheHits++;}catch(error){if(error.code!=='ENOENT'&&error.message!=='Corrupt cache'&&!(error instanceof SyntaxError))throw error;missing.push({...object,path});}}
 for(let i=0;i<missing.length;i+=2){const group=missing.slice(i,i+2);const data=await request('/projects/'+project+'/objects',{objects:group.map(({type,oid})=>({type,oid}))});for(const object of data.objects){const key=object.type+':'+object.oid;const expected=group.find(v=>v.type===object.type&&v.oid===object.oid);if(!expected)throw Error('Unexpected object');if(object.type==='blob'&&oid(Buffer.from(object.value,'base64'))!==object.oid)throw Error('Blob identity mismatch');const text=JSON.stringify({object,checksum:hash(JSON.stringify(object))});await evict(Buffer.byteLength(text));const temp=expected.path+'.'+randomUUID()+'.tmp';await writeFile(temp,text,{mode:0o600});await rename(temp,expected.path);result.set(key,object.value);counters.networkObjects++;}}
 return result;
}
async function blob(ref,path,identity){
 const key=join(cacheRoot,hash(scope+'blob:'+identity)+'.json');try{const stored=JSON.parse(await readFile(key,'utf8'));const bytes=Buffer.from(stored.value,'base64');if(oid(bytes)===identity){counters.cacheHits++;return bytes;}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
 const response=await fetch(base+'/api/projects/'+project+'/blob?ref='+ref+'&path='+encodeURIComponent(path),{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Raw file read failed: '+response.status);
 const reader=response.body.getReader(),chunks=[];let total=0;try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>32*1024*1024)throw Error('File exceeds 32 MiB');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=Buffer.concat(chunks);if(oid(bytes)!==identity)throw Error('Blob identity mismatch');const serialized=JSON.stringify({value:bytes.toString('base64')});await evict(Buffer.byteLength(serialized));const temp=key+'.'+randomUUID()+'.tmp';await writeFile(temp,serialized,{mode:0o600});await rename(temp,key);counters.networkObjects++;return bytes;
}
const object=async(type,oid)=>(await objects([{type,oid}])).get(type+':'+oid);
async function scopedEntries(ref,paths,allowMissing=false){const selected=new Map();let trees=0;
 const within=p=>allowedPaths.some(prefix=>p===prefix||p.startsWith(prefix+'/'));
 async function walk(path){if(++trees>4096)throw Error('At most 4,096 directories per materialization');let listing;try{listing=await request('/projects/'+project+'/tree?ref='+ref+'&path='+encodeURIComponent(path));}catch(error){if(error.status!==404)throw error;const parts=path.split('/'),name=parts.pop();let parent;try{parent=await request('/projects/'+project+'/tree?ref='+ref+'&path='+encodeURIComponent(parts.join('/')));}catch(e){if(allowMissing&&e.status===404)return;throw e;}const entry=parent.entries.find(row=>row.name===name);if(!entry&&allowMissing)return;if(!entry||entry.type==='tree')throw Error('File not found: '+path);selected.set(path,entry);return;}
 for(const entry of listing.entries){const current=safe(path+'/'+entry.name);if(!within(current))throw Error('Path is outside the credential scope');if(entry.type==='tree')await walk(current);else selected.set(current,entry);if(selected.size>10000)throw Error('At most 10,000 files per materialization');}}
 for(const path of paths){safe(path);if(!within(path))throw Error('Path is outside the credential scope');await walk(path);}return selected;
}
async function entries(ref,paths,allowMissing=false){if(allowedPaths)return scopedEntries(ref,paths,allowMissing);const commit=await object('commit',ref);const selected=new Map();let trees=0;
 async function walk(tree,path,recursive){if(++trees>4096)throw Error('At most 4,096 directories per materialization');const items=await object('tree',tree);for(const item of items){const p=path?path+'/'+item.name:item.name;safe(p);if(recursive&&item.type==='tree')await walk(item.oid,p,true);else if(item.type!=='tree')selected.set(p,item);if(selected.size>10000)throw Error('At most 10,000 files per materialization');}}
 requestedPaths: for(const requested of paths){safe(requested);let tree=commit.tree;const components=requested.split('/');for(let i=0;i<components.length;i++){const row=(await object('tree',tree)).find(v=>v.name===components[i]);if(!row){if(allowMissing)continue requestedPaths;throw Error('Path not found: '+requested);}if(i===components.length-1){if(row.type==='tree')await walk(row.oid,requested,true);else selected.set(requested,row);}else{if(row.type!=='tree'){if(allowMissing)continue requestedPaths;throw Error('Not a directory');}tree=row.oid;}}}
 return selected;
}
async function safeParents(root,path){const r=relative(root,resolve(root,path));if(r.startsWith('..')||isAbsolute(r))throw Error('Path escapes workspace');let cursor=root;for(const name of r.split('/').slice(0,-1)){cursor=join(cursor,name);try{const s=await lstat(cursor);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe parent directory');}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(cursor);}}}
async function materialize(root,manifest,paths){const wanted=await entries(manifest.ref,paths);for(const [path,entry]of wanted){if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode))throw Error('Symlinks/submodules require explicit handling: '+path);await safeParents(root,path);try{const info=await lstat(join(root,path));if(!info.isFile()||info.isSymbolicLink())throw Error('Unsafe destination');const content=await readFile(join(root,path));const tracked=manifest.files[path];if(!tracked||oid(content)!==tracked.oid)throw Error('Local changes would be overwritten: '+path);}catch(e){if(e.code!=='ENOENT')throw e;}}
 for(const [path,entry]of wanted){const content=allowedPaths?entry.content??await blob(manifest.ref,path,entry.oid):await blob(manifest.ref,path,entry.oid);if(oid(content)!==entry.oid)throw Error('Blob identity mismatch');const temp=join(dirname(join(root,path)),'.squali-'+randomUUID()+'.tmp');await writeFile(temp,content,{mode:entry.mode==='100755'?0o755:0o644});await rename(temp,join(root,path));await chmod(join(root,path),entry.mode==='100755'?0o755:0o644);manifest.files[path]={oid:entry.oid,mode:entry.mode};}
 manifest.paths=[...new Set([...manifest.paths,...paths])];await save(root,manifest);return {files:wanted.size,ref:manifest.ref,...counters};
}
async function pendingUpdate(root){try{return JSON.parse(await readFile(join(root,'.squali','update.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function diskEntry(root,path){
 safe(path);await safeParents(root,path);
 try{const info=await lstat(join(root,path));if(!info.isFile()||info.isSymbolicLink())throw Error('Unsafe update destination: '+path);return {oid:oid(await readFile(join(root,path))),mode:info.mode&0o111?'100755':'100644'};}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
const sameEntry=(a,b)=>a?.oid===b?.oid&&a?.mode===b?.mode;
async function update(root,manifest,requested){
 const journalPath=join(root,'.squali','update.json');let journal=await pendingUpdate(root);
 if(journal&&requested&&requested!==journal.target.ref)throw Error('Resume the pending update before selecting another commit');
 if(!journal){
  if((await changes(root,manifest)).length)throw Error('Commit or preserve local changes before updating');
  const ref=requested??(await request('/projects/'+project)).head;if(!/^[a-f0-9]{40}$/.test(ref??''))throw Error('Update requires an immutable commit ID');
  const wanted=await entries(ref,manifest.paths,true),files={},actions=[];
  for(const [path,entry] of wanted){if(entry.type!=='blob'||!['100644','100755'].includes(entry.mode))throw Error('Symlinks/submodules require explicit handling: '+path);files[path]={oid:entry.oid,mode:entry.mode};}
  for(const path of [...new Set([...Object.keys(manifest.files),...Object.keys(files)])].sort()){
   const before=manifest.files[path]??null,after=files[path]??null;if(sameEntry(before,after))continue;
   const current=await diskEntry(root,path);if(!sameEntry(current,before))throw Error('Local or untracked content would be overwritten: '+path);
   actions.push({path,before,after,stage:String(actions.length)});
  }
  const stage='.update-'+randomUUID();await mkdir(join(root,'.squali',stage),{mode:0o700});let bytes=0;
  try{
   for(const action of actions){if(!action.after)continue;const content=await blob(ref,action.path,action.after.oid);bytes+=content.length;if(bytes>256*1024*1024)throw Error('Update downloads exceed 256 MiB');await writeFile(join(root,'.squali',stage,action.stage),content,{mode:0o600});}
   journal={version:1,origin:base,project,from:manifest.ref,stage,target:{...manifest,ref,files},actions};
   // Exclusive creation keeps two prepared updates from replacing each other's journal.
   await writeFile(journalPath,JSON.stringify(journal),{mode:0o600,flag:'wx'});
  }catch(error){await rm(join(root,'.squali',stage),{recursive:true,force:true});throw error;}
 }
 if(journal.version!==1||journal.origin!==base||journal.project!==project||![journal.from,journal.target.ref].includes(manifest.ref)||!/^\.update-[a-f0-9-]+$/.test(journal.stage))throw Error('Invalid working-copy update journal');
 // Validate every path before applying any further action, including after a crash.
 for(const action of journal.actions){
  if(allowedPaths&&!allowedPaths.some(prefix=>action.path===prefix||action.path.startsWith(prefix+'/')))throw Error('Path is outside the credential scope');
  const current=await diskEntry(root,action.path);if(!sameEntry(current,action.before)&&!sameEntry(current,action.after))throw Error('Content changed since update preparation: '+action.path);
 }
 for(const action of journal.actions){
  const current=await diskEntry(root,action.path);if(sameEntry(current,action.after))continue;
  if(!action.after){await unlink(join(root,action.path));continue;}
  if(!/^\d+$/.test(action.stage))throw Error('Invalid update stage');const staged=join(root,'.squali',journal.stage,action.stage);const content=await readFile(staged);if(oid(content)!==action.after.oid)throw Error('Staged object identity mismatch');
  // Set mode before replacement, so a crash cannot leave a half-applied mode change.
  await chmod(staged,action.after.mode==='100755'?0o755:0o644);await rename(staged,join(root,action.path));
 }
 await save(root,journal.target);await unlink(journalPath);await rm(join(root,'.squali',journal.stage),{recursive:true,force:true});
 return {ref:journal.target.ref,files:Object.keys(journal.target.files).length,updated:journal.actions.length,...counters};
}
async function add(root,manifest,paths){
 if(!paths.length||paths.length>64)throw Error('add <directory> <file...>; select 1–64 regular files');
 const additions=[];
 for(const path of [...new Set(paths)]){
  safe(path);if(allowedPaths&&!allowedPaths.some(prefix=>path===prefix||path.startsWith(prefix+'/')))throw Error('Path is outside the credential scope');
  if(manifest.files[path])continue;
  await safeParents(root,path);const info=await lstat(join(root,path));if(!info.isFile()||info.isSymbolicLink())throw Error('Only regular files can be added');
  const data=await readFile(join(root,path));if(data.length>256*1024||data.includes(0))throw Error('Editing supports UTF-8 text up to 256 KiB');new TextDecoder('utf-8',{fatal:true}).decode(data);
  let absent=false;try{await request('/projects/'+project+'/file?ref='+manifest.ref+'&path='+encodeURIComponent(path));}catch(error){if(error.status!==404)throw error;absent=true;}
  if(!absent)throw Error('Remote file already exists; hydrate it before editing: '+path);
  additions.push({path,mode:info.mode&0o111?'100755':'100644'});
 }
 for(const entry of additions){manifest.files[entry.path]={oid:null,mode:entry.mode};manifest.paths=[...new Set([...manifest.paths,entry.path])];}
 await save(root,manifest);return {added:additions.map(entry=>entry.path),base:manifest.ref};
}
async function save(root,manifest){await mkdir(join(root,'.squali'),{recursive:true,mode:0o700});const path=join(root,'.squali','manifest.json'),temp=path+'.tmp';await writeFile(temp,JSON.stringify(manifest,null,2),{mode:0o600});await rename(temp,path);}
async function load(root){const manifest=JSON.parse(await readFile(join(root,'.squali','manifest.json'),'utf8'));if(manifest.origin!==base)throw Error('Use the original SQUALI_URL');await authorize(manifest.project);return manifest;}
async function changes(root,manifest){const result=[];for(const [path,entry]of Object.entries(manifest.files)){await safeParents(root,safe(path));try{const info=await lstat(join(root,path));if(!info.isFile()||info.isSymbolicLink())throw Error('Unsupported filesystem object');const data=await readFile(join(root,path));const mode=info.mode&0o111?'100755':'100644';if(oid(data)!==entry.oid||mode!==entry.mode){if(data.length>256*1024||data.includes(0))throw Error('Editing supports UTF-8 text up to 256 KiB');result.push({path,content:new TextDecoder('utf-8',{fatal:true}).decode(data),mode});}}catch(e){if(e.code!=='ENOENT')throw e;if(entry.oid!==null)result.push({path,content:null});}}return result;}
let result;
if(command==='checkout') {const [pid,target,...paths]=args;if(!target||!paths.length)throw Error('checkout <project> <new-directory> <path...>');await authorize(pid);const root=resolve(target);await mkdir(root,{mode:0o700});const info=await request('/projects/'+project);result=await materialize(root,{version:1,origin:base,project,ref:info.head,paths,files:{}},paths);}
else if(['hydrate','status','propose','add','update'].includes(command)){const root=resolve(args[0]??'');const manifest=await load(root);if(command!=='update'&&await pendingUpdate(root))throw Error('Resume the pending update before another working-copy command');if(command==='update'){result=await update(root,manifest,args[1]);}else if(command==='add'){result=await add(root,manifest,args.slice(1));}else if(command==='hydrate'){if(args.length<2)throw Error('hydrate <directory> <path...>');result=await materialize(root,manifest,args.slice(1));}else{const files=await changes(root,manifest);if(command==='status')result={base:manifest.ref,changes:files.map(f=>({path:f.path,deleted:f.content===null,mode:f.mode}))};else{if(!args[1]||!args[2]||!files.length)throw Error('propose <directory> <id> <title>; tracked changes required');result=await request('/projects/'+project+'/changes',{id:args[1],title:args[2],intent:args[2],base:manifest.ref,files});if(!/^[a-f0-9]{40}$/.test(result.oid??''))throw Error('Server did not confirm a durable commit');manifest.ref=result.oid;for(const file of files){if(file.content===null)delete manifest.files[file.path];else manifest.files[file.path]={oid:oid(Buffer.from(file.content)),mode:file.mode??manifest.files[file.path]?.mode??'100644'};}await save(root,manifest);}}}
else throw Error('Commands: checkout, hydrate, add, update, status, propose');
console.log(JSON.stringify(result,null,2));

import type {Artifacts as Storage,Repository,Sql,TreeEntry} from './types.ts';
import {Problem} from './types.ts';
import {operationBudget} from './budget.ts';
import {pushHttp} from './git.ts';

/** Counts attempted provider calls, including failed and unknown outcomes. No automatic retries. */
export function cloudArtifacts(binding:Artifacts,sql:Sql,cap:number):Storage {
 if(!Number.isSafeInteger(cap)||cap<1||cap>100000)throw new Error('MONTHLY_ARTIFACT_CALL_CAP must be 1–100000');
 const reserve=operationBudget(sql,cap);
 const use=async<T>(name:string,fn:(r:ArtifactsRepo)=>Promise<T>)=>{await reserve(2);using repo=await binding.get(name);return await fn(repo);};
 return {
  async create(name){
   await reserve(1);
   try{using repo=await binding.get(name);return;}catch(e){if((e as {code?:string}).code!=='NOT_FOUND')throw e;}
   await reserve(1);await binding.create(name,{description:'Weave agent collaboration',setDefaultBranch:'main'});
  },
  repo(name):Repository {return {
   info:()=>use(name,async r=>{const info=await r.info();return {name:info.name,remote:info.remote};}),
   head:(ref='main')=>use(name,async r=>{const log=await r.log({ref,limit:1});return log[0]?.hash??null;}),
   commit:oid=>use(name,async r=>{const c=await r.readCommit(oid);return c?{oid:c.hash,tree:c.treeHash,parents:c.parents,message:c.message}:null;}),
   tree:oid=>use(name,async r=>{const entries=await r.readTree(oid);if(!entries)throw new Problem(404,'tree_missing','Git tree not found');return entries.map(e=>({name:e.name,oid:e.hash,mode:e.type==='tree'?'40000':e.type==='exec'?'100755':e.type==='symlink'?'120000':e.type==='gitlink'?'160000':'100644',type:e.type==='tree'?'tree':e.type==='gitlink'?'commit':'blob'} as TreeEntry));}),
   blob:oid=>use(name,async r=>{const blob=await r.readBlob(oid);if(!blob)throw new Problem(404,'blob_missing','Git blob not found');if(blob.size>256*1024)throw new Problem(413,'blob_limit','File exceeds API editing limit');return new Uint8Array(await blob.arrayBuffer());}),
   async git(request,suffix){await reserve(4);using repo=await binding.get(name);const info=await repo.info();const token=await repo.createToken('read',60);return fetch(info.remote.replace(/\/$/,'')+suffix,{method:request.method,headers:{authorization:`Bearer ${token.plaintext}`,'content-type':request.headers.get('content-type')??'application/x-git-upload-pack-request'},body:request.method==='POST'?await request.arrayBuffer():undefined,redirect:'error',signal:AbortSignal.timeout(20000)});},
   async push(ref,old,oid,pack){
    // Short-lived credentials are request-local and never persisted or returned to clients.
    await reserve(4);using repo=await binding.get(name);const info=await repo.info();const token=await repo.createToken('write',60);
    if(new URL(info.remote).protocol!=='https:')throw new Problem(502,'remote','Artifacts returned an insecure Git remote');
    await pushHttp(info.remote,token.plaintext,ref,old,oid,pack);
   }
  };}
 };
}

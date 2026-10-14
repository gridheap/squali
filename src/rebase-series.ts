import {Problem,type Config,type Principal} from './types.ts';
import {sha256} from './git.ts';
import type {changeService} from './changes.ts';
import type {metadataService} from './metadata.ts';
export async function rebaseSeries(config:Config,project:string,principal:Principal,input:any,changes:ReturnType<typeof changeService>,metadata:ReturnType<typeof metadataService>){
 const {id,commits,onto}=input,limit=input.limit??8,note=input.note??'Rebase branch through fresh review';
 if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(id)||!Array.isArray(commits)||!commits.length||commits.length>64||commits.some(c=>typeof c!=='string'||!/^[a-f0-9]{40}$/.test(c))||new Set(commits).size!==commits.length||typeof onto!=='string'||!/^[a-f0-9]{40}$/.test(onto)||!Number.isInteger(limit)||limit<1||limit>8||typeof note!=='string'||note.length>4000)throw new Problem(400,'rebase_series','Supply an ID, 1–64 ordered commits, immutable target and 1–8 steps per request');
 const resolutions=input.resolutions??{};if(!resolutions||Array.isArray(resolutions)||typeof resolutions!=='object'||Object.keys(resolutions).some(k=>!commits.includes(k)))throw new Problem(400,'rebase_resolutions','Resolutions must belong to this branch');
 const frozen={commits,onto,note},identity=sha256(JSON.stringify(frozen)),sql=config.sql;
 // Immutable proposal IDs make replay safe. Only the small result cursor needs CAS.
 {
  let [job]=await sql`SELECT * FROM weave_rebases WHERE project=${project} AND id=${id}`;
  if(job&&(job.author!==principal.id||job.request_hash!==identity))throw new Problem(409,'idempotency_mismatch','Rebase ID already has different source, target or author');
  if(!job){
   let previous:string|null=null;for(const oid of commits){const commit=await metadata.commit(oid);if(commit.parents.length>1||(previous&&commit.parents[0]!==previous))throw new Problem(400,'rebase_chain','Supply a continuous single-parent branch; merge commits require explicit individual rebase');previous=oid;}
   await metadata.commit(onto);const result={id,state:'running',completed:0,head:onto,changes:[],resolutions:{},conflicts:[]};
   [job]=await sql`INSERT INTO weave_rebases(project,id,author,request_hash,input,result) VALUES(${project},${id},${principal.id},${identity},${sql.json(frozen)},${sql.json(result)}) ON CONFLICT DO NOTHING RETURNING *`;
   if(!job)[job]=await sql`SELECT * FROM weave_rebases WHERE project=${project} AND id=${id}`;
   if(job.author!==principal.id||job.request_hash!==identity)throw new Problem(409,'idempotency_mismatch','Rebase ID already has different source, target or author');
  }
  const previous=structuredClone(job.result),result=job.result;
  for(const [oid,hash]of Object.entries(result.resolutions)){if(resolutions[oid]&&sha256(JSON.stringify(resolutions[oid]))!==hash)throw new Problem(409,'rebase_resolution_changed','An already rewritten commit has different resolutions');}
  if(result.state==='complete')return result;
  result.state='running';result.conflicts=[];
  for(let step=0;step<limit&&result.completed<commits.length;step++){
   const oid=commits[result.completed],resolved=resolutions[oid]??[],cid='rb-'+sha256(project+':'+id).slice(0,32)+'-'+result.completed;
   let plan;try{plan=await metadata.rebase(oid,result.head,undefined,resolved);}catch(error){if(error instanceof Problem&&error.code==='rebase_conflict'){result.state='blocked';result.conflicts=(error.details as any).conflicts;result.blockedCommit=oid;break;}throw error;}
   const change=await changes.propose({id:cid,title:'Rebase '+oid.slice(0,12),intent:note,context:{rebaseSeries:{id,commit:oid,onto:result.head,resolutionsHash:sha256(JSON.stringify(resolved))}},dependencies:result.changes.length?[result.changes.at(-1).id]:[],base:result.head,files:plan.files});
   result.changes.push({original:oid,id:cid,oid:change.oid});result.head=change.oid;result.resolutions[oid]=sha256(JSON.stringify(resolved));result.completed++;delete result.blockedCommit;
  }
  if(result.completed===commits.length)result.state='complete';
  const updated=await sql`UPDATE weave_rebases SET result=${sql.json(result)},updated_at=now() WHERE project=${project} AND id=${id} AND result=${sql.json(previous)} RETURNING result`;
  if(!updated.length){const [latest]=await sql`SELECT result FROM weave_rebases WHERE project=${project} AND id=${id}`;if(JSON.stringify(latest.result)===JSON.stringify(result))return latest.result;throw new Problem(409,'rebase_busy','Another request advanced this rebase; resume the saved cursor');}return result;
 }
}

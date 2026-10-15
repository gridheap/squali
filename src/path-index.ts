import type {TransactionSql} from 'postgres';
import {Problem,type Sql} from './types.ts';
import {resolveDerivedBatch} from './derived-data.ts';

type Paths={gitOid:string;firstParent:string|null;depth:number;count:number;paths?:string[]};
export function derivePathValue(gitOid:string,firstParent:string|null,parent:Paths|undefined,paths:string[]):Paths{
 return {gitOid,firstParent,depth:firstParent?parent!.depth+1:0,count:paths.length,paths};
}
type PreparedPathInput={firstParent:string|null;paths:string[];bytes:number};
/** Path events use the same bounded dependency engine as graph/tree results.
 * A marker, including an empty delta, is stored only after its path rows exist. */
export async function completePathBatch(sql:Sql|TransactionSql<{}>,project:string,ids:string[],prepared=new Map<string,PreparedPathInput>()){
 const kind='source-paths:v1';let pathCount=0,metadataBytes=0;
 return resolveDerivedBatch<Paths,{paths:string[]}>({kind:'source-paths',version:1,
  async read(keys){return new Map((await sql`SELECT key,value FROM weave_derived WHERE project=${project} AND kind=${kind} AND key=ANY(${keys})`).map(r=>[r.key,r.value as Paths]));},
  async load(keys){
   // The sealing transaction may supply its validated canonical delta. Lazy
   // reconstruction uses exactly the same resolver and SQL fallback below.
   const missing=keys.filter(key=>!prepared.has(key));
   for(const key of keys){const value=prepared.get(key);if(value){pathCount+=value.paths.length;metadataBytes+=value.bytes;}}
   const sizes=missing.length?await sql`SELECT git_oid,jsonb_array_length(files) AS count,octet_length(files::text) AS bytes FROM weave_changesets WHERE project=${project} AND git_oid=ANY(${missing})`:[];
   for(const row of sizes){pathCount+=Number(row.count);metadataBytes+=Number(row.bytes);}
   if(pathCount>100000||metadataBytes>16*1024*1024)throw new Problem(422,'derived_budget','Derive earlier path batches first: limit 100,000 events and 16 MiB metadata');
   const rows=missing.length?await sql`SELECT c.git_oid,c.files,cardinality(c.parents) AS parent_count,p.git_oid AS parent FROM weave_changesets c LEFT JOIN weave_changesets p ON p.project=c.project AND p.id=c.parents[1] WHERE c.project=${project} AND c.git_oid=ANY(${missing})`:[];
   if(rows.some(row=>Number(row.parent_count)>0&&!row.parent))throw new Problem(409,'derived_input','Canonical path parent is missing');
   const loaded=new Map(rows.map(r=>[r.git_oid,{key:r.git_oid,parents:r.parent?[r.parent]:[],input:{paths:[...new Set<string>(r.files.map((f:any)=>f.path))]}}]));
   for(const key of keys){const value=prepared.get(key);if(value)loaded.set(key,{key,parents:value.firstParent?[value.firstParent]:[],input:{paths:value.paths}});}
   return loaded;
  },
  async compute(inputs,resolved){const values=new Map<string,Paths>();for(const node of inputs){const firstParent=node.parents[0]??null,value=derivePathValue(node.key,firstParent,firstParent?resolved.get(firstParent):undefined,node.input.paths);values.set(node.key,value);resolved.set(node.key,value);}return values;},
  async save(values){
   const paths=[...values.values()].flatMap(value=>value.paths!.map(path=>({project,version:1,path,git_oid:value.gitOid})));
   for(let at=0;at<paths.length;at+=2000)await sql`INSERT INTO weave_source_paths ${sql(paths.slice(at,at+2000),'project','version','path','git_oid')} ON CONFLICT DO NOTHING`;
   const markers=[...values.values()].map(({paths,...value})=>({project,kind,key:value.gitOid,value:sql.json(value)}));
   for(let at=0;at<markers.length;at+=128)await sql`INSERT INTO weave_derived ${sql(markers.slice(at,at+128),'project','kind','key','value')} ON CONFLICT DO NOTHING`;
  }
 },ids);
}

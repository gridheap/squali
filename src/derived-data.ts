import {Problem} from './types.ts';
import type {Sql} from './types.ts';

export interface DerivedInput<I> {key:string;parents:string[];input:I}
export interface DerivedBatch<T,I> {
 kind:string;version:number;
 read(keys:string[]):Promise<Map<string,T>>;
 load(keys:string[]):Promise<Map<string,DerivedInput<I>>>;
 compute(inputs:DerivedInput<I>[],resolved:Map<string,T>):Promise<Map<string,T>>;
 save(values:Map<string,T>):Promise<void>;
}

/** One versioned dependency resolver for eager batches and lazy misses. Storage
 * and vectorized calculation are adapters; ordering, reuse and bounds are shared. */
export async function resolveDerivedBatch<T,I>(definition:DerivedBatch<T,I>,keys:string[],limit=1024){
 if(!/^[a-z][a-z0-9-]*$/.test(definition.kind)||!Number.isSafeInteger(definition.version)||definition.version<1)throw new Problem(500,'derived_definition','Invalid derivation identity');
 const resolved=new Map<string,T>(),pending=new Map<string,DerivedInput<I>>(),seen=new Set<string>();let frontier=[...new Set(keys)];
 while(frontier.length){
  for(const key of frontier)seen.add(key);if(seen.size>8192)throw new Problem(422,'derived_budget','Derivation exceeds 8,192 dependency records');
  for(const [key,value]of await definition.read(frontier))resolved.set(key,value);
  const missing=frontier.filter(key=>!resolved.has(key));
  if(pending.size+missing.length>limit)throw new Problem(422,'derived_budget','Derive earlier changesets in bounded parent-order batches first');
  if(!missing.length)break;const loaded=await definition.load(missing);
  for(const key of missing){const node=loaded.get(key);if(!node||node.key!==key)throw new Problem(409,'derived_input','Canonical derivation input is missing');pending.set(key,node);}
  frontier=[...new Set(missing.flatMap(key=>pending.get(key)!.parents))].filter(key=>!resolved.has(key)&&!pending.has(key));
 }
 const ordered:DerivedInput<I>[]=[],visited=new Set<string>(),active=new Set<string>();
 function visit(key:string){if(resolved.has(key)||visited.has(key))return;if(active.has(key))throw new Problem(409,'derived_cycle','Derived dependency graph contains a cycle');const node=pending.get(key);if(!node)throw new Problem(409,'derived_input','Derived dependency is missing');active.add(key);node.parents.forEach(visit);active.delete(key);visited.add(key);ordered.push(node);}
 keys.forEach(visit);
 const computed=ordered.length?await definition.compute(ordered,resolved):new Map<string,T>();
 if(computed.size!==ordered.length||ordered.some(node=>!computed.has(node.key)))throw new Problem(500,'derived_result','Derivation did not produce every admitted result');
 if(computed.size)await definition.save(computed);for(const [key,value]of computed)resolved.set(key,value);
 return {values:keys.map(key=>resolved.get(key)!),computed:computed.size};
}

export interface Derivation<T> {
 kind:string;version:number;
 dependencies(key:string):Promise<string[]>;
 compute(key:string,parents:T[]):Promise<T>;
}
export function derivedData(sql:Sql,project:string){
 async function batch<T>(definition:Derivation<T>,keys:string[],limit=1024):Promise<T[]>{
  const kind=definition.kind+':v'+definition.version;
  const result=await resolveDerivedBatch<T,null>({kind:definition.kind,version:definition.version,
   async read(ids){return new Map((await sql`SELECT key,value FROM weave_derived WHERE project=${project} AND kind=${kind} AND key=ANY(${ids})`).map(row=>[row.key,row.value as T]));},
   async load(ids){return new Map(await Promise.all(ids.map(async key=>[key,{key,parents:await definition.dependencies(key),input:null}] as const)));},
   async compute(nodes,resolved){const values=new Map<string,T>();for(const node of nodes){const value=await definition.compute(node.key,node.parents.map(key=>resolved.get(key)!));values.set(node.key,value);resolved.set(node.key,value);}return values;},
   async save(values){const rows=[...values].map(([key,value])=>({project,kind,key,value:sql.json(value as any)}));for(let i=0;i<rows.length;i+=128)await sql`INSERT INTO weave_derived ${sql(rows.slice(i,i+128),'project','kind','key','value')} ON CONFLICT DO NOTHING`;}
  },keys,limit);
  return result.values;
 }
 return {batch};
}

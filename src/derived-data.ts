import {Problem} from './types.ts';
import type {Sql} from './types.ts';
export interface Derivation<T> {
 kind:string;version:number;
 dependencies(key:string):Promise<string[]>;
 compute(key:string,parents:T[]):Promise<T>;
}
/** The same bounded resolver serves eager batches and lazy reads. Versions never overwrite each other. */
export function derivedData(sql:Sql,project:string){
 async function batch<T>(definition:Derivation<T>,keys:string[],limit=1024):Promise<T[]>{
  const kind=definition.kind+':v'+definition.version,memo=new Map<string,T>(),active=new Set<string>();let work=0;
  async function resolve(key:string):Promise<T>{
   if(memo.has(key))return memo.get(key)!;
   const [cached]=await sql`SELECT value FROM weave_derived WHERE project=${project} AND kind=${kind} AND key=${key}`;
   if(cached){memo.set(key,cached.value);return cached.value;}
   if(active.has(key))throw new Problem(409,'derived_cycle','Derived dependency graph contains a cycle');
   if(++work>limit)throw new Problem(422,'derived_budget','Derive earlier changesets in bounded parent-order batches first');active.add(key);
   const parents:T[]=[];for(const dependency of await definition.dependencies(key))parents.push(await resolve(dependency));
   const value=await definition.compute(key,parents);await sql`INSERT INTO weave_derived(project,kind,key,value) VALUES(${project},${kind},${key},${sql.json(value as any)}) ON CONFLICT DO NOTHING`;
   active.delete(key);memo.set(key,value);return value;
  }
  const results:T[]=[];for(const key of keys)results.push(await resolve(key));return results;
 }
 return {batch};
}

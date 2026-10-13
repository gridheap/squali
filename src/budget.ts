import type {Artifacts,Repository,Sql} from './types.ts';
import {Problem} from './types.ts';
export function operationBudget(sql:Sql,cap:number){
 if(!Number.isSafeInteger(cap)||cap<1||cap>1000000)throw new Error('Invalid operation cap');
 return async(n:number)=>{
  if(n>cap)throw new Problem(429,'provider_budget','The operation exceeds the configured call budget');
  const month=new Date().toISOString().slice(0,7);
  const rows=await sql`INSERT INTO weave_usage(month,attempts) VALUES(${month},${n}) ON CONFLICT(month) DO UPDATE SET attempts=weave_usage.attempts+${n} WHERE weave_usage.attempts+${n}<=${cap} RETURNING attempts`;
  if(!rows.length)throw new Problem(429,'provider_budget','The monthly Artifacts call budget is exhausted');
 };
}
export function meteredLocal(storage:Artifacts,sql:Sql,cap:number):Artifacts{
 const reserve=operationBudget(sql,cap);
 return {async create(name,branch){await reserve(1);return storage.create(name,branch);},repo(name){const repo=storage.repo(name);const result:Record<string,unknown>={};for(const [key,fn] of Object.entries(repo))result[key]=async(...args:unknown[])=>{await reserve(1);return fn(...args);};return result as unknown as Repository;}};
}

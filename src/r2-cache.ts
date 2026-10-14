import type {ObjectCache} from './cache.ts';
import type {Sql} from './types.ts';
import {Problem} from './types.ts';

type Bucket={get(key:string):Promise<{size?:number;httpMetadata?:{contentType?:string};arrayBuffer():Promise<ArrayBuffer>}|null>;put(key:string,value:Uint8Array,options:{httpMetadata:{contentType:string}}):Promise<unknown>};
const MAX_ITEM=1024*1024;
/** Private, disposable immutable tier. All callers must already be authorized. */
export function r2ObjectCache(bucket:Bucket,sql:Sql,caps:{reads:number;writes:number}):ObjectCache{
 const available={reads:0,writes:0};
 async function reserve(kind:'reads'|'writes'){
  if(available[kind]){available[kind]--;return;}
  const cap=caps[kind];if(!Number.isSafeInteger(cap)||cap<1)throw new Problem(503,'r2_config','R2 budgets are not configured');
  const amount=Math.min(kind==='reads'?8:4,cap);const month=new Date().toISOString().slice(0,7);
  const rows=await sql`INSERT INTO weave_cache_usage(month,kind,reservations) VALUES(${month},${kind},${amount}) ON CONFLICT(month,kind) DO UPDATE SET reservations=weave_cache_usage.reservations+${amount} WHERE weave_cache_usage.reservations+${amount}<=${cap} RETURNING reservations`;
  if(!rows.length)throw new Problem(429,'r2_budget','The monthly immutable-cache request budget is exhausted');available[kind]=amount-1;
 }
 const key=(path:string)=>'objects/v1/'+path;
 return {
  async get(path){
   await reserve('reads');let object;
   try{object=await bucket.get(key(path));}catch{throw new Problem(503,'r2_unavailable','The shared object cache is unavailable. Origin fallback is paused to protect capacity.');}
   if(!object){const [pending]=await sql`SELECT key FROM weave_cache_entries WHERE key=${key(path)} AND expires_at>now()`;if(pending)throw new Problem(503,'r2_fill_pending','An immutable cache upload is pending or failed; origin refill is paused.');return undefined;}
   if((object.size??0)>MAX_ITEM)throw new Problem(503,'r2_corrupt','Cached object exceeds its size bound');
   const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length>MAX_ITEM)throw new Problem(503,'r2_corrupt','Cached object exceeds its size bound');
   if(object.httpMetadata?.contentType==='application/octet-stream')return bytes;
   try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Problem(503,'r2_corrupt','Cached object is invalid');}
  },
  async set(path,value){
   const binary=value instanceof Uint8Array;const bytes=binary?value:new TextEncoder().encode(JSON.stringify(value));if(bytes.byteLength>MAX_ITEM)return;
   // A persistent immutable key claim deduplicates writes across Worker instances.
   // Interrupted uploads are not blindly replayed; Git remains authoritative.
   const claim=await sql`INSERT INTO weave_cache_entries(key,expires_at) VALUES(${key(path)},now()+interval '7 days') ON CONFLICT(key) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE weave_cache_entries.expires_at<now() RETURNING key`;
   if(!claim.length)return;
   try{await reserve('writes');await bucket.put(key(path),bytes,{httpMetadata:{contentType:binary?'application/octet-stream':'application/json'}});}catch(error){await sql`UPDATE weave_cache_entries SET expires_at=now()+interval '5 minutes' WHERE key=${key(path)}`;if(error instanceof Problem)throw error;throw new Problem(503,'r2_unavailable','The immutable cache upload did not complete; origin refill is paused for five minutes');}
  }
 };
}

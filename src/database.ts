import postgres from 'postgres';
import {createHash} from 'node:crypto';
import {startStage} from './timing.ts';

/** Hyperdrive supports prepared statements. Disabling them adds parameter-type
 * discovery messages that its transaction pooling does not reliably support.
 * This schema uses arrays: retain discovered codecs when skipping catalog I/O.
 * Only immutable codec functions cross request boundaries, never a SQL client,
 * socket, query promise, transaction or authentication result. */
type Codecs={expires:number;parsers:Record<number,(value:any)=>unknown>;serializers:Record<number,(value:any)=>unknown>};
const codecs=new Map<string,Codecs>();
const startups=new WeakMap<ReturnType<typeof postgres>,{started:boolean;ready:boolean;end?:()=>void}>();
const cacheableOptions=new Set(['max','idle_timeout','connect_timeout','connection','onnotice','debug']);
export function connectDatabase(url:string,options:Omit<postgres.Options<{}>,'prepare'|'fetch_types'>={}){
 // Custom socket/type/transform/session options retain their own discovery.
 const key=Object.keys(options).every(k=>cacheableOptions.has(k))?createHash('sha256').update(JSON.stringify([url,options.connection??{}])).digest('hex'):undefined;
 const entry=key?codecs.get(key):undefined,cached=entry&&entry.expires>Date.now()?entry:undefined;
 const startup={started:false,ready:false,end:undefined as (()=>void)|undefined};
 const sql=postgres(url,{max:1,...options,prepare:true,fetch_types:!cached,debug:(id,query,parameters,types)=>{
  if(typeof options.debug==='function')options.debug(id,query,parameters,types);
  // The driver's first business-query callback runs after startup and native
  // type discovery. No extra query or reserve call is needed. Postgres.js 3.4.9
  // can hang on reserve() as its first operation when fetch_types is false.
  if(startup.ready||query.includes('pg_catalog.pg_type'))return;
  startup.ready=true;startup.end?.();startup.end=undefined;
 }});
 if(cached){Object.assign(sql.options.parsers,cached.parsers);Object.assign(sql.options.serializers,cached.serializers);}
 const end=sql.end;
 sql.end=async options=>{
  // Cache only after completed queries: native discovery finishes asynchronously
  // after its ReadyForQuery message. Never snapshot an incomplete registry.
  await end(options);
  // Native array serializers retain their options object. Detach callbacks so
  // the cached codecs cannot retain this request's client or diagnostic closure.
  sql.options.debug=false;sql.options.onnotice=()=>{};startup.end=undefined;
  if(!key||cached||!sql.options.parsers[1009]||Object.keys(sql.options.parsers).length>512||Object.keys(sql.options.serializers).length>512)return;
  if(codecs.size>=4&&!codecs.has(key))codecs.delete(codecs.keys().next().value!);
  codecs.set(key,{expires:Date.now()+300000,parsers:{...sql.options.parsers},serializers:{...sql.options.serializers}});
 };
 startups.set(sql,startup);
 return sql;
}

/** Mark startup immediately before the first real SQL operation. The driver
 * callback closes this span before it sends that operation. Public requests
 * remain lazy. The first query's enclosing stage includes this startup span. */
export function databaseReady(sql:ReturnType<typeof postgres>){
 return async()=>{const startup=startups.get(sql);if(startup?.ready){startStage('db_connect')();return;}if(startup&&!startup.started){startup.started=true;startup.end=startStage('db_connect');}};
}

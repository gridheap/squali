import type {Artifacts,Repository} from './types.ts';
export interface ObjectCache {get(key:string):Promise<unknown|undefined>;set(key:string,value:unknown):Promise<void>}
/** Call only behind authentication. Keys include repository and immutable Git object IDs. */
export function cachedArtifacts(storage:Artifacts,cache:ObjectCache):Artifacts {
 return {create:name=>storage.create(name),repo(name){const repo=storage.repo(name);const cached=async<T>(type:string,oid:string,read:()=>Promise<T>)=>{const key=`${name}/${type}/${oid}`;const hit=await cache.get(key);if(hit!==undefined)return hit as T;const value=await read();if(value!==null)await cache.set(key,value);return value;};return {...repo,commit:oid=>cached('commit',oid,()=>repo.commit(oid)),tree:oid=>cached('tree',oid,()=>repo.tree(oid)),blob:oid=>cached('blob',oid,()=>repo.blob(oid))} as Repository;}};
}
export function memoryCache(maxBytes=8*1024*1024):ObjectCache {
 const entries=new Map<string,{value:unknown;size:number}>();let bytes=0;
 return {async get(key){const hit=entries.get(key);if(hit){entries.delete(key);entries.set(key,hit);return hit.value;}},async set(key,value){const size=value instanceof Uint8Array?value.byteLength:Buffer.byteLength(JSON.stringify(value));if(size>maxBytes)return;const old=entries.get(key);if(old){bytes-=old.size;entries.delete(key);}while(bytes+size>maxBytes&&entries.size){const first=entries.keys().next().value!;bytes-=entries.get(first)!.size;entries.delete(first);}entries.set(key,{value,size});bytes+=size;}};
}
export function edgeCache(cache:Cache):ObjectCache {
 const key=(path:string)=>new Request('https://weave-object-cache.invalid/v1/'+path);
 return {async get(path){const response=await cache.match(key(path));if(!response)return undefined;return response.headers.get('content-type')==='application/octet-stream'?new Uint8Array(await response.arrayBuffer()):response.json();},async set(path,value){const binary=value instanceof Uint8Array;const response=new Response(binary?Buffer.from(value):JSON.stringify(value),{headers:{'content-type':binary?'application/octet-stream':'application/json','cache-control':'public, max-age=86400, immutable'}});await cache.put(key(path),response);}};
}

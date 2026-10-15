import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {SourceBucket} from '../src/source-store.ts';
/** Persistent local adapter for the public R2 binding boundary. */
export function fileBucket(root:string):SourceBucket{
 const path=(key:string)=>{if(!/^(?:blobs|git-snapshots)\/v1\/[a-f0-9]{64}$/.test(key))throw Error('Invalid source key');return join(root,key);};
 return {
  async get(key){try{const data=await readFile(path(key));return {arrayBuffer:async()=>Uint8Array.from(data).buffer};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
  async head(key){try{return {size:(await stat(path(key))).size,customMetadata:JSON.parse(await readFile(path(key)+'.json','utf8'))};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
  async put(key,data,options){const target=path(key);await mkdir(dirname(target),{recursive:true,mode:0o700});const temp=target+'.'+randomUUID();await writeFile(temp,data,{mode:0o600});await writeFile(target+'.json',JSON.stringify(options.customMetadata),{mode:0o600});await rename(temp,target);return {};}
 };
}

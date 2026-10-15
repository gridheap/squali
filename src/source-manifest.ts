import {createHash} from 'node:crypto';
import type {Commit} from './types.ts';

/** The same identity for imported trees and an admitted writer's known delta. */
export function sourceManifest(commit:Commit,raw:Uint8Array,parents:string[],files:any[]){
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const data=Buffer.from(raw),split=data.indexOf('\n\n');
 const metadata={rawSuffix:data.subarray(data.indexOf(10)+1).toString('base64'),headers:data.subarray(0,split).toString().split('\n').filter(line=>!line.startsWith('tree ')),message:commit.message};
 const manifest={version:1,parents,files,metadata};
 return {id:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),parents,files,metadata};
}

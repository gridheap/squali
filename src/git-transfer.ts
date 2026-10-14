import {pkt,readPackets} from './git.ts';
import {Problem,ZERO} from './types.ts';
export type GitRef={name:string;oid:string;old?:string};
export const validRef=(name:string)=>/^refs\/(heads|tags)\/.+/.test(name)&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(name)&&!name.includes('..')&&!name.includes('@{')&&!name.endsWith('/')&&!name.endsWith('.')&&!name.split('/').some(p=>p.startsWith('.')||p.endsWith('.lock'));
export async function limitedBytes(response:Response,limit:number){
 if(!response.ok){await response.body?.cancel();throw new Problem(response.status===404?404:response.status===401||response.status===403?403:502,'upstream','Repository provider request failed. Check GitHub access and retry.');}
 const reader=response.body?.getReader();if(!reader)throw new Problem(502,'upstream','Provider returned no body');const chunks:Buffer[]=[];let n=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>limit)throw new Problem(413,'transfer_limit','Provider response exceeds the configured limit');chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}finally{await reader.cancel().catch(()=>{});}
}
export async function advertisedRefs(response:Response):Promise<GitRef[]>{
 const lines=readPackets(await limitedBytes(response,2*1024*1024));const refs:GitRef[]=[];
 for(const line of lines){const match=line.split('\0')[0].trim().match(/^([a-f0-9]{40}) (refs\/(?:heads|tags)\/.+)$/);if(!match||match[2].endsWith('^{}'))continue;if(!validRef(match[2]))throw new Problem(422,'unsupported_ref','Repository contains an unsupported ref name');refs.push({name:match[2],oid:match[1]});}
 if(refs.length>5000)throw new Problem(413,'ref_limit','At most 5,000 branches and tags per import');return refs;
}
export async function sourceRefs(remote:string,token:string){return advertisedRefs(await fetch(remote+'/info/refs?service=git-upload-pack',{headers:{authorization:'Basic '+Buffer.from('x-access-token:'+token).toString('base64')},redirect:'manual',signal:AbortSignal.timeout(20000)}));}
export async function sourcePack(remote:string,token:string,refs:GitRef[],maxBytes:number){
 const wants=[...new Set(refs.map(r=>r.oid))];const request=Buffer.concat([...wants.map((oid,i)=>pkt(`want ${oid}${i===0?' ofs-delta':''}\n`)),Buffer.from('0000'),pkt('done\n')]);
 const response=await fetch(remote+'/git-upload-pack',{method:'POST',headers:{authorization:'Basic '+Buffer.from('x-access-token:'+token).toString('base64'),'content-type':'application/x-git-upload-pack-request'},body:request,redirect:'manual',signal:AbortSignal.timeout(55000)});
 if(!response.ok||!response.body){await response.body?.cancel();throw new Problem(502,'git_download','GitHub could not supply the repository pack');}
 const reader=response.body.getReader();let prefix=Buffer.alloc(0);let bytes=0;let ready=false;
 const stream=new ReadableStream<Uint8Array>({async pull(controller){try{while(true){const {done,value}=await reader.read();if(done){if(!ready)throw new Problem(502,'git_protocol','Missing Git pack');controller.close();return;}bytes+=value.length;if(bytes>maxBytes)throw new Problem(413,'import_size','Git pack exceeds the import byte limit');if(ready){controller.enqueue(value);return;}prefix=Buffer.concat([prefix,value]);if(prefix.length<8)continue;const len=parseInt(prefix.subarray(0,4).toString(),16);if(!Number.isFinite(len)||len<4||len>65520)throw new Problem(502,'git_protocol','Invalid upload-pack response');if(prefix.length<len+4)continue;if(prefix.subarray(4,len).toString()!=='NAK\n'||prefix.subarray(len,len+4).toString()!=='PACK')throw new Problem(502,'git_protocol','Expected a complete Git pack');ready=true;controller.enqueue(prefix.subarray(len));prefix=Buffer.alloc(0);return;}}catch(e){await reader.cancel().catch(()=>{});controller.error(e);}},cancel:()=>reader.cancel()});
 return {stream,bytes:()=>bytes};
}
export async function receivePack(remote:string,token:string,refs:GitRef[],stream:ReadableStream<Uint8Array>){
 const advertisement=readPackets(await limitedBytes(await fetch(remote.replace(/\/$/,'')+'/info/refs?service=git-receive-pack',{headers:{authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(15000)}),2*1024*1024));
 const capabilities=advertisement.find(line=>line.includes('\0'))?.split('\0')[1]?.trim().split(' ')??[];
 if(!capabilities.includes('report-status')){await stream.cancel();throw new Problem(502,'git_capability','Destination does not support Git receive status reports');}
 const requested='report-status'+(capabilities.includes('atomic')?' atomic':'');
 const commands=Buffer.concat([...refs.map((ref,i)=>pkt(`${ref.old??ZERO} ${ref.oid} ${ref.name}${i===0?'\0'+requested:''}\n`)),Buffer.from('0000')]);
 const reader=stream.getReader();let first=true;
 const body=new ReadableStream<Uint8Array>({async pull(controller){if(first){first=false;controller.enqueue(commands);return;}try{const {done,value}=await reader.read();if(done)controller.close();else controller.enqueue(value);}catch(e){controller.error(e);}},cancel:()=>reader.cancel()});
 try{
  const response=await fetch(remote.replace(/\/$/,'')+'/git-receive-pack',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/x-git-receive-pack-request'},body,duplex:'half',signal:AbortSignal.timeout(55000),redirect:'manual'} as RequestInit);
  const lines=readPackets(await limitedBytes(response,2*1024*1024));if(!lines.includes('unpack ok\n')||refs.some(r=>!lines.includes(`ok ${r.name}\n`)))throw new Problem(409,'import_push','Git rejected the import; resume reconciles every destination ref');
 }finally{await reader.cancel().catch(()=>{});}
}

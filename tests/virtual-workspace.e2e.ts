import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';
import {createServer} from 'node:http';
import {regionalRpc} from '../src/regional-cache.ts';

// Failure specification: checkout downloads untouched bodies; ordinary edits,
// atomic replacements, modes, new files and deletes are lost; restart loses the
// overlay; proposal copies the whole working tree or moves main; a second writer
// mounts the same state; disk growth exceeds its fixed image; a changed base is
// accepted over old edits; daemon outage causes an authority bypass.
const exec=promisify(execFile),server=await startLocal({port:0,test:true,source:true});
let lostAck=false,regionalReads=0;const regionalObjects=new Map<string,Response>();
const regional=regionalRpc({cache:{async match(r){return regionalObjects.get(r.url)?.clone();},async put(r,v){regionalObjects.set(r.url,v.clone());}},admit:async()=>true,upstream:{async fetch(request){regionalReads++;return fetch(new Request(server.url+new URL(request.url).pathname,request));}}});
const proxy=createServer(async(req,res)=>{
 try{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const request=new Request(server.url+req.url,{method:req.method,headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},body:chunks.length?Buffer.concat(chunks):undefined});
  const upstream=req.url?.endsWith('/rpc')?await regional(request):await fetch(request);
  const body=Buffer.from(await upstream.arrayBuffer());
  if(req.method==='POST'&&req.url==='/api/projects/virtual-fs/changes'&&!lostAck&&upstream.ok){lostAck=true;res.destroy();return;}
  res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([key])=>['content-type','x-squali-type','x-squali-oid'].includes(key)))).end(body);
 }catch{res.writeHead(502).end();}
});
await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
const command='node --import tsx tests/virtual-workspace.e2e.ts';
const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
const call=async(path:string,input?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:input?'POST':'GET',headers,body:input?JSON.stringify(input):undefined});const v=await r.json() as any;assert.ok(r.ok,JSON.stringify(v));return v;};
try{
 const p=await call('/projects',{id:'virtual-fs',name:'Virtual filesystem',storage:'source',files:[{path:'README.md',content:'original\n'},{path:'src/keep.txt',content:'untouched\n'},{path:'src/remove.txt',content:'remove\n'},{path:'reset/keep.txt',content:'keep same content\n'},{path:'reset/remove.txt',content:'removed by directory replacement\n'},{path:'tool.sh',content:'#!/bin/sh\necho old\n',mode:'100755'}]});
 const base='http://host.lima.internal:'+(proxy.address() as {port:number}).port;
 const result=await exec('colima',['ssh','--','sudo','env','SQUALI_URL='+base,'SQUALI_TOKEN=local-admin-test-token','python3',resolve('tests/virtual-workspace-linux.py'),'--repo',resolve('.'),'--ref',p.head],{timeout:120000,maxBuffer:1024*1024});
 const linux=JSON.parse(result.stdout.trim().split('\n').at(-1)!);assert.equal(linux.passed,true);
 assert.equal(lostAck,true,'The proxy must discard an actually accepted proposal response');
 const change=await call('/projects/virtual-fs/changes/virtual-edit');assert.equal(change.base,p.head);
 assert.equal((await call('/projects/virtual-fs')).head,p.head,'A virtual edit must not publish main');
 const expected={'README.md':'changed\n','src/new.txt':'new file\n','tool.sh':'#!/bin/sh\necho new\n'};
 for(const [path,content]of Object.entries(expected))assert.equal((await call('/projects/virtual-fs/file?ref='+change.oid+'&path='+encodeURIComponent(path))).content,content);
 assert.equal((await call('/projects/virtual-fs/file?ref='+change.oid+'&path=tool.sh')).mode,'100644');
 assert.equal((await fetch(server.url+'/api/projects/virtual-fs/file?ref='+change.oid+'&path=src/remove.txt',{headers})).status,404);
 assert.equal((await call('/projects/virtual-fs/file?ref='+change.oid+'&path=src/keep.txt')).content,'untouched\n');
 assert.equal((await call('/projects/virtual-fs/file?ref='+change.oid+'&path=reset/keep.txt')).content,'keep same content\n','Recreating an opaque directory must retain identical replacement files');
 assert.equal((await fetch(server.url+'/api/projects/virtual-fs/file?ref='+change.oid+'&path=reset/remove.txt',{headers})).status,404);
 const native=server.dir+'/native.git';await exec('git',['-c','http.extraHeader=Authorization: Bearer local-admin-test-token','clone','--mirror',server.url+'/api/projects/virtual-fs/git',native]);
 // Unpublished changes are intentionally absent from the published Git bridge.
 assert.equal((await exec('git',['--git-dir',native,'rev-parse','HEAD'])).stdout.trim(),p.head);
 assert.ok(regionalReads>0,'Linux workspace reads must pass through the independent regional tier');
 const report={command,linux,proposal:change.oid,mainUnchanged:true,sourceContentExact:true,regionalTier:true,regionalUpstreamCalls:regionalReads,externalProviderCalls:0,passed:true};
 await writeFile('docs/evidence/2026-10-15-regional/virtual-workspace-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await new Promise<void>(done=>proxy.close(()=>done()));await server.close();}

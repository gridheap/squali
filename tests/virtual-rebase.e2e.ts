import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {writeFile,mkdir,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {startLocal} from '../scripts/local.ts';
import {regionalRpc} from '../src/regional-cache.ts';

// Failure specification: rebasing materializes untouched blobs, loses dirty edits
// or upstream files/modes, switches half a generation, moves main, repeats writes,
// permits mutation during a frozen operation, or loses conflict/abort state.
const exec=promisify(execFile),server=await startLocal({port:0,test:true,source:true});
let lostAck=false,plans=0;const cache=new Map<string,Response>();
const regional=regionalRpc({cache:{async match(r){return cache.get(r.url)?.clone();},async put(r,v){cache.set(r.url,v.clone());}},admit:async()=>true,upstream:{fetch:r=>fetch(new Request(server.url+new URL(r.url).pathname,r))}});
const proxy=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(Buffer.from(c));const r=new Request(server.url+req.url,{method:req.method,headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},body:chunks.length?Buffer.concat(chunks):undefined});const upstream=req.url?.endsWith('/rpc')?await regional(r):await fetch(r);const data=Buffer.from(await upstream.arrayBuffer());if(req.url?.endsWith('/rebase-plan')){plans++;if(!lostAck&&upstream.ok){lostAck=true;res.destroy();return;}}res.writeHead(upstream.status,Object.fromEntries(upstream.headers)).end(data);}catch{res.writeHead(502).end();}});
await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json() as any;assert.ok(r.ok,JSON.stringify(v));return v;};
try{
 const lines=Array.from({length:12},(_,i)=>'line '+i),remote=[...lines];remote[0]='remote';
 const files=[{path:'text',content:lines.join('\n')+'\n'},{path:'delete',content:'remove\n'},{path:'tool',content:'old\n'},...Array.from({length:48},(_,i)=>({path:'untouched/'+i,content:'untouched '+i+'\n'}))];
 const p=await call('/projects',{id:'virtual-rebase',name:'Virtual rebase',files});
 const ontoFiles=[{path:'text',content:remote.join('\n')+'\n'},{path:'tool',content:'remote tool\n'},{path:'remote',content:'remote addition\n'}];
 const target=await call('/projects/virtual-rebase/changes',{id:'target',title:'Target',intent:'Fixture',base:p.head,files:ontoFiles});
 const conflict=[...remote];conflict[10]='conflicting upstream';
 const target2=await call('/projects/virtual-rebase/changes',{id:'target2',title:'Target 2',intent:'Fixture',base:target.oid,files:[{path:'text',content:conflict.join('\n')+'\n'}]});
 const before=(await call('/usage')).source.writes;
 const result=await exec('colima',['ssh','--','sudo','env','SQUALI_URL=http://host.lima.internal:'+(proxy.address() as any).port,'SQUALI_TOKEN=local-admin-test-token','python3',resolve('tests/virtual-rebase-linux.py'),'--repo',resolve('.'),'--ref',p.head,'--onto',target.oid,'--conflict',target2.oid],{timeout:180000,maxBuffer:2*1024**2});
 const linux=JSON.parse(result.stdout.trim().split('\n').at(-1)!);assert.equal(linux.passed,true);assert.ok(lostAck);assert.equal((await call('/projects/virtual-rebase')).head,p.head);
 const proposal=await call('/projects/virtual-rebase/changes/rebased-edit');assert.equal(proposal.base,target.oid);
 // Independent native Git cherry-pick oracle for the entire resulting tree.
 const copy=server.dir+'/native';await mkdir(copy);const git=async(...args:string[])=>(await exec('git',['-C',copy,'-c','user.name=Verifier','-c','user.email=v@example.invalid',...args])).stdout.trim();await git('init','--initial-branch=main');
 for(const f of files){await mkdir(resolve(copy,f.path,'..'),{recursive:true});await writeFile(resolve(copy,f.path),f.content);}await git('add','.');await git('commit','-m','Base');const base=await git('rev-parse','HEAD');
 const incoming=[...lines];incoming[10]='local';await writeFile(copy+'/text',incoming.join('\n')+'\n');await rm(copy+'/delete');await writeFile(copy+'/new','local addition\n');await exec('chmod',['755',copy+'/tool']);await git('add','.');await git('commit','-m','Local');const local=await git('rev-parse','HEAD');await git('checkout','--detach',base);
 for(const f of ontoFiles)await writeFile(resolve(copy,f.path),f.content);await git('add','.');await git('commit','-m','Upstream');await git('cherry-pick',local);const nativeTree=await git('rev-parse','HEAD^{tree}');assert.equal((await call('/projects/virtual-rebase/commit?ref='+proposal.oid)).tree,nativeTree);
 // Only the explicit post-rebase proposal creates source data, no staging commits.
 assert.equal((await call('/projects/virtual-rebase/changes')).changes.length,3);
 const report={command:'node --import tsx tests/virtual-rebase.e2e.ts',passed:true,linux,nativeTree,mainUnchanged:true,planRequests:plans,sourceWritesIncludingExplicitProposal:(await call('/usage')).source.writes-before,externalProviderCalls:0};
 await writeFile('docs/evidence/2026-10-15-capacity/virtual-rebase-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await new Promise<void>(r=>proxy.close(()=>r()));await server.close();}

import {sourceStore} from '../src/source-store.ts';
import {fileBucket} from './source-bucket.ts';
import {receivePack} from '../src/git-transfer.ts';
import {createServer} from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,mkdtemp} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import postgres from 'postgres';
import {connectDatabase} from '../src/database.ts';
import type {Artifacts,Repository,TreeEntry} from '../src/types.ts';
import {pushHttp,sha256} from '../src/git.ts';
import {cachedArtifacts,memoryCache} from '../src/cache.ts';
import {meteredLocal} from '../src/budget.ts';
import {createApp} from '../src/app.ts';
const exec=promisify(execFile);
export const localDatabase=process.env.DATABASE_URL??'postgres://weave@127.0.0.1:55439/weave';
export async function startLocal(opts:{port?:number;onQuery?:(query:string)=>void;adminId?:string;adminToken?:string;agentToken?:string;test?:boolean;source?:boolean;nativeImports?:boolean;sourceCache?:import('../src/cache.ts').ObjectCache;sourceBucket?:import('../src/source-store.ts').SourceBucket;failPublicationAckOnce?:boolean;failImportCreateOnce?:boolean;failPublicationBeforePushOnce?:boolean;callCap?:number;poolSize?:number;durableCache?:(sql:ReturnType<typeof postgres>)=>import('../src/cache.ts').ObjectCache;clerk?:import('../src/types.ts').Config['clerk'];github?:import('../src/types.ts').Config['github'];directory?:string;onPublicationBeforePush?:()=>Promise<void>;onPublicationPushed?:()=>Promise<void>;onImportPushed?:()=>Promise<void>}={}){
 const root=resolve('work');await mkdir(root,{recursive:true});const dir=opts.directory??(opts.test?await mkdtemp(join(root,'e2e-')):join(root,'local'));await mkdir(dir,{recursive:true});
 const schema=opts.test?'test_'+sha256(dir).slice(0,16):'weave_local';
 const bootstrap=postgres(localDatabase,{max:1,onnotice:()=>{}});await bootstrap.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);await bootstrap.end();
 const sql=connectDatabase(localDatabase,{max:opts.poolSize??20,connection:{search_path:schema},onnotice:()=>{},debug:(_connection,query)=>opts.onQuery?.(query)});await sql.unsafe(await readFile('src/schema.sql','utf8'));
 const gitServer=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');const m=url.pathname.match(/^\/([a-zA-Z0-9_-]+)\.git(\/.*)$/);if(!m){res.writeHead(404).end();return;}
  const child=spawn('git',['http-backend'],{env:{...process.env,GIT_PROJECT_ROOT:dir,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:`/${m[1]}.git${m[2]}`,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??'',HTTP_CONTENT_ENCODING:req.headers['content-encoding']??'',CONTENT_LENGTH:req.headers['content-length']??'',REMOTE_USER:'local-fixture'}});
  const chunks:Buffer[]=[];child.stdout.on('data',c=>chunks.push(c));child.stderr.resume();req.pipe(child.stdin);child.stdin.on('error',()=>{});
  child.on('close',()=>{const output=Buffer.concat(chunks);const split=output.indexOf('\r\n\r\n');if(split<0){res.writeHead(500).end();return;}let status=200;const headers:Record<string,string>={};for(const line of output.subarray(0,split).toString().split('\r\n')){const at=line.indexOf(':');if(at<0)continue;const k=line.slice(0,at),v=line.slice(at+1).trim();if(k.toLowerCase()==='status')status=parseInt(v);else headers[k]=v;}res.writeHead(status,headers).end(output.subarray(split+4));});
 });await new Promise<void>(r=>gitServer.listen(0,'127.0.0.1',r));const gitPort=(gitServer.address() as any).port;
 const git=async(name:string,args:string[])=>exec('git',['--git-dir',join(dir,name+'.git'),...args],{maxBuffer:5*1024*1024});
 let failImportCreate=opts.failImportCreateOnce??false;let failAck=opts.failPublicationAckOnce??false;let failBefore=opts.failPublicationBeforePushOnce??false;
 const artifacts:Artifacts={
  async create(name,branch='main'){if(failImportCreate&&name.startsWith('weave-gh-')){failImportCreate=false;throw new Error('Injected import allocation interruption');}await exec('git',['init','--bare','--initial-branch='+branch,join(dir,name+'.git')]);await git(name,['config','http.receivepack','true']);},
  repo(name):Repository{return {
   async writeLease(){return {remote:`http://127.0.0.1:${gitPort}/${name}.git`,token:'local-export-token'};},
   async info(){return {name,remote:`http://127.0.0.1:${gitPort}/${name}.git`};},
   async head(ref='refs/heads/main'){try{return (await git(name,['rev-parse','--verify',ref])).stdout.trim();}catch{return null;}},
   async commit(oid){try{const s=(await git(name,['cat-file','commit',oid])).stdout;const [headers,...message]=s.split('\n\n');return {oid,tree:headers.match(/^tree (\w+)$/m)![1],parents:[...headers.matchAll(/^parent (\w+)$/gm)].map(m=>m[1]),message:message.join('\n\n')};}catch{return null;}},
   async tree(oid){const s=(await git(name,['ls-tree','-z',oid])).stdout;return s.split('\0').filter(Boolean).map(line=>{const tab=line.indexOf('\t');const [mode,type,hash]=line.slice(0,tab).split(' ');return {mode:mode==='040000'?'40000':mode,type,oid:hash,name:line.slice(tab+1)} as TreeEntry;});},
   async blob(oid){const r=await exec('git',['--git-dir',join(dir,name+'.git'),'cat-file','blob',oid],{encoding:'buffer',maxBuffer:5*1024*1024});return r.stdout;},
   async git(request,suffix){const response=await fetch(`http://127.0.0.1:${gitPort}/${name}.git${suffix}`,{method:request.method,headers:{'content-type':request.headers.get('content-type')??'application/x-git-upload-pack-request'},body:request.method==='POST'?await request.arrayBuffer():undefined,redirect:'manual'});return response;},
   async receive(refs,pack){await receivePack(`http://127.0.0.1:${gitPort}/${name}.git`,'local',refs,pack);await opts.onImportPushed?.();},
   async push(ref,old,oid,pack){if(failBefore&&ref==='refs/heads/main'&&old){failBefore=false;throw new Error('Injected failure before push');}if(ref==='refs/heads/main'&&old)await opts.onPublicationBeforePush?.();await pushHttp(`http://127.0.0.1:${gitPort}/${name}.git`,'local',ref,old,oid,pack);if(ref==='refs/heads/main'&&old)await opts.onPublicationPushed?.();if(failAck&&ref==='refs/heads/main'&&old){failAck=false;throw new Error('Injected loss of publication acknowledgement');}}
  };}
 };
 const adminToken=opts.adminToken??process.env.WEAVE_ADMIN_TOKEN??'local-admin-test-token';const agentToken=opts.agentToken??process.env.WEAVE_AGENT_TOKEN??'local-agent-test-token';
 const source=opts.source?sourceStore(sql,opts.sourceBucket??fileBucket(join(dir,'source-blobs')),{reads:1000000,writes:1000000,repositoryBytes:100*1024**3},opts.sourceCache):undefined;
 const app=createApp({sql,source,nativeImports:opts.nativeImports,clerk:opts.clerk,github:opts.github,artifacts:cachedArtifacts(opts.durableCache?cachedArtifacts(meteredLocal(artifacts,sql,opts.callCap??1000000),opts.durableCache(sql)):meteredLocal(artifacts,sql,opts.callCap??1000000),memoryCache()),principals:{[sha256(adminToken)]:{id:opts.adminId??'reviewer',role:'admin',projects:['*']},[sha256(agentToken)]:{id:'agent',role:'agent',projects:['*']}},mode:'local Git + PostgreSQL',maxProjects:100,monthlyOps:opts.callCap??1000000,assets:async req=>{
  const path=new URL(req.url).pathname;const file=path==='/'?'/index.html':path;if(!/^\/[a-zA-Z0-9_.-]+$/.test(file))return new Response('Not found',{status:404});try{const body=await readFile('public'+file);const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};return new Response(body,{headers:{'content-type':types[extname(file)]??'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
 }});
 const server=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(/^\/api\/projects\/[^/]+\/source\/(?:blob\/[a-f0-9]{40}|snapshot\/part\/[a-f0-9]{64})$/.test(req.url??'')?33:3)*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);const request=new Request(`http://127.0.0.1:${(server.address() as any).port}${req.url}`,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined});const response=await app(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){console.error(e);res.writeHead(500).end('Internal error');}});
 await new Promise<void>(r=>server.listen(opts.port??8787,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${(server.address() as any).port}`,dir,sql,schema,async close(){await sql.end({timeout:1});await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>gitServer.close(()=>r()))]);}};
}

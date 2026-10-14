import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {once} from 'node:events';
import {startLocal} from '../scripts/local.ts';

function rpc(path:string,input:any):Promise<{status:number;headers:Record<string,string>;body:Buffer}>{return new Promise((resolve,reject)=>{const socket=createConnection(path);let chunks:Buffer[]=[];socket.on('error',reject);socket.on('connect',()=>{const body=Buffer.from(JSON.stringify(input)),size=Buffer.alloc(4);size.writeUInt32BE(body.length);socket.end(Buffer.concat([size,body]));});socket.on('data',b=>chunks.push(Buffer.isBuffer(b)?b:Buffer.from(b)));socket.on('end',()=>{try{const raw=Buffer.concat(chunks),size=raw.readUInt32BE(),meta=JSON.parse(raw.subarray(4,4+size).toString()),body=raw.subarray(4+size);assert.equal(body.length,meta.length);resolve({...meta,body});}catch(e){reject(e);}});});}

test('node daemon coalesces misses, persists verified objects, restores a refreshed snapshot and isolates failed reads',{timeout:30000},async()=>{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048}),domain='node.clerk.accounts.dev';
 const server=await startLocal({port:0,test:true,source:true,clerk:{publishableKey:'pk_test_'+Buffer.from(domain+'$').toString('base64'),secretKey:'sk_test_fixture',jwtKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()}});
 const now=Math.floor(Date.now()/1000),input=[{alg:'RS256',typ:'JWT',kid:'fixture'},{iss:'https://'+domain,sub:'user_owner',sid:'session',azp:server.url,iat:now,nbf:now-5,exp:now+300}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.'),owner=input+'.'+sign('RSA-SHA256',Buffer.from(input),keys.privateKey).toString('base64url');
 const headers={authorization:'Bearer '+owner,'content-type':'application/json'};const http=async(path:string,value?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:value===undefined?'GET':'POST',headers,body:value===undefined?undefined:JSON.stringify(value)});const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};let daemon:ReturnType<typeof spawn>|undefined;
 const socket='/tmp/sq-node-'+randomUUID()+'.sock';
 const stop=async()=>{if(daemon&&daemon.exitCode===null){daemon.kill('SIGTERM');await once(daemon,'exit');}daemon=undefined;};
 try{
  const p=await http('/projects',{id:'node-source',name:'Node cache',storage:'source',files:[{path:'file.txt',content:'one immutable body\n'}]});
  const t=await http('/projects/node-source/tokens',{label:'Daemon acceptance',role:'reader',days:1});const file=await http('/projects/node-source/file?path=file.txt');
  const start=async(cache:string,restore?:string)=>{daemon=spawn('python3',['scripts/node-daemon.py','--socket',socket,'--cache',cache,'--max-bytes','10485760',...(restore?['--restore',restore]:[])],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:t.token},stdio:['ignore','pipe','pipe']});const errors:Buffer[]=[];daemon.stderr!.on('data',b=>errors.push(b));const result=await Promise.race([once(daemon.stdout!,'data').then(([b])=>JSON.parse(b.toString())),once(daemon,'exit').then(()=>{throw Error(Buffer.concat(errors).toString());})]);assert.equal(result.ready,true);};
  await start(server.dir+'/cache-one');const before=(await http('/usage')).source.reads;
  const query={project:'node-source',op:'object',oid:file.oid};const responses=await Promise.all(Array.from({length:12},()=>rpc(socket,query)));for(const r of responses){assert.equal(r.status,200);assert.equal(r.body.toString(),'one immutable body\n');}
  assert.equal((await http('/usage')).source.reads-before,1,'Twelve misses must produce one source read');
  const stat=JSON.parse((await rpc(socket,{op:'stats'})).body.toString());assert.equal(stat.originObjects,1);assert.ok(stat.coalesced+stat.hits>=11);
  const snapshot=JSON.parse((await rpc(socket,{op:'snapshot',name:'warm'})).body.toString());assert.ok(snapshot.bytes>0);await stop();
  await start(server.dir+'/cache-two',snapshot.path);const warm=await rpc(socket,query);assert.equal(warm.body.toString(),'one immutable body\n');assert.equal((await http('/usage')).source.reads-before,1);
  assert.equal((await rpc(socket,{...query,project:'other-project'})).status,403);
  const failures=await Promise.all(Array.from({length:12},()=>rpc(socket,{...query,oid:'a'.repeat(40)})));assert.ok(failures.every(r=>r.status===404));const end=JSON.parse((await rpc(socket,{op:'stats'})).body.toString());assert.equal(end.originObjects,1,'One bounded failed origin attempt, with a shared cooldown');assert.equal(end.hits,1);
  console.log(JSON.stringify({command:'node --import tsx --test tests/node-cache.test.ts',concurrentReaders:12,sourceReads:1,snapshotRestored:true,unauthorizedWorkspaceDenied:true,failedOriginAttempts:1,head:p.head}));
 }finally{await stop();await server.close();}
});

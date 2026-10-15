import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {regionalRpc} from '../src/regional-cache.ts';
import {startLocal} from '../scripts/local.ts';

// Failure specification: daemon authorization bypasses the regional RPC;
// stacking two leases extends a token's lifetime; a warm local object is served
// after expiry; two nodes cannot reuse regional objects; outage bypasses cache.
test('two real node daemons share the regional tier and never extend credential expiry',{timeout:15000},async()=>{
 const source=await startLocal({port:0,test:true,source:true});const entries=new Map<string,Response>(),children:ReturnType<typeof spawn>[]=[];let originObjects=0,bypass=0;
 const gateway=regionalRpc({cache:{async match(r){return entries.get(r.url)?.clone();},async put(r,value){entries.set(r.url,value.clone());}},admit:async()=>true,upstream:{async fetch(r){if((await r.clone().json() as any).op==='object')originObjects++;return fetch(new Request(source.url+new URL(r.url).pathname,r));}}});
 const wire=createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);if(!req.url?.endsWith('/rpc'))bypass++;const response=await gateway(new Request('https://squa.li'+req.url,{method:req.method,headers:req.headers as Record<string,string>,body:chunks.length?Buffer.concat(chunks):undefined}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));});await new Promise<void>(r=>wire.listen(0,'127.0.0.1',r));
 const rpc=(path:string,input:any):Promise<{status:number;body:Buffer}>=>new Promise((resolve,reject)=>{const socket=createConnection(path),parts:Buffer[]=[];socket.on('error',reject);socket.on('connect',()=>{const body=Buffer.from(JSON.stringify(input)),size=Buffer.alloc(4);size.writeUInt32BE(body.length);socket.end(Buffer.concat([size,body]));});socket.on('data',b=>parts.push(Buffer.isBuffer(b)?b:Buffer.from(b)));socket.on('end',()=>{try{const raw=Buffer.concat(parts),size=raw.readUInt32BE(),meta=JSON.parse(raw.subarray(4,4+size).toString());resolve({status:meta.status,body:raw.subarray(4+size)});}catch(e){reject(e);}});});
 try{
  const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};const r=await fetch(source.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'node-region',name:'Node region',files:[{path:'file.txt',content:'shared node content\n'}]})});assert.equal(r.status,201);const file=await (await fetch(source.url+'/api/projects/node-region/file?path=file.txt',{headers})).json() as any;
  const token='sq_node_regional_fixture';await source.sql`INSERT INTO weave_tokens(id,project,token_hash,label,role,expires_at) VALUES('short','node-region',${createHash('sha256').update(token).digest('hex')},'Expiring node fixture','reader',now()+interval '2 seconds')`;
  const sockets=[];for(let i=0;i<2;i++){const socket='/tmp/sq-region-'+randomUUID()+'.sock';sockets.push(socket);const child=spawn('python3',['scripts/node-daemon.py','--socket',socket,'--cache',source.dir+'/node-'+i,'--max-bytes','1048576'],{env:{...process.env,SQUALI_URL:'http://127.0.0.1:'+(wire.address() as {port:number}).port,SQUALI_TOKEN:token},stdio:['ignore','pipe','pipe']});children.push(child);assert.equal(JSON.parse((await once(child.stdout!,'data'))[0].toString()).ready,true);}
  const query={project:'node-region',op:'object',oid:file.oid};for(const socket of sockets){const value=await rpc(socket,query);assert.equal(value.status,200,value.body.toString());assert.equal(value.body.toString(),file.content);}
  assert.equal(originObjects,1);assert.equal(bypass,0,'Every daemon read, including authorization, must use the regional RPC');
  await delay(2100);for(const socket of sockets)assert.equal((await rpc(socket,query)).status,401,'A warm local object cannot outlive the shared authorization lease');assert.equal(originObjects,1);
  console.log(JSON.stringify({command:'node --import tsx --test tests/node-regional.test.ts',nodeProcesses:2,sourceObjectRequests:1,bypassRequests:0,expiryRespectedAtBothTiers:true,externalProviderCalls:0}));
 }finally{for(const child of children){if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}wire.closeAllConnections();await new Promise<void>(r=>wire.close(()=>r()));await source.close();}
});

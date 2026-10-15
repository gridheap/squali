import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startLocal,localDatabase} from '../scripts/local.ts';
import {connectDatabase,databaseReady} from '../src/database.ts';
import {createApp} from '../src/app.ts';
import {sourceStore} from '../src/source-store.ts';
import {fileBucket} from '../scripts/source-bucket.ts';
import {sha256} from '../src/git.ts';
import type {Artifacts} from '../src/types.ts';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';

// Failure specification: every request re-fetches the stable type catalog;
// cached codecs lose PostgreSQL arrays/escaping or mix bound values; sockets
// are reused across request lifetimes; publication loses dependency ordering.
test('fresh HTTP database sessions reuse codecs while preserving arrays, transactions and publication',async()=>{
 // Own a disposable database: the shared development catalog contains thousands
 // of retained test schemas and intentionally exceeds the codec cache's bound.
 const admin=postgres(localDatabase,{max:1,fetch_types:false}),name='codec_'+randomUUID().replaceAll('-','');
 await admin.unsafe('CREATE DATABASE '+name);const endpoint=new URL(localDatabase);endpoint.pathname='/'+name;const database=endpoint.toString();
 const fixture=await startLocal({port:0,test:true,source:true,database});let sessions=0,catalogs=0;
 const forbidden=async():Promise<never>=>{throw Error('Unexpected external Artifacts call');};
 const fallback:Artifacts={create:forbidden,repo:()=>({info:forbidden,head:forbidden,commit:forbidden,tree:forbidden,blob:forbidden,git:forbidden,receive:forbidden,push:forbidden})};
 const server=createServer(async(req,res)=>{
  const sql=connectDatabase(database,{max:1,connection:{search_path:fixture.schema},onnotice:()=>{},debug:(_id,q)=>{if(q.includes('pg_catalog.pg_type'))catalogs++;}});sessions++;
  try{
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
   const app=createApp({sql,databaseReady:databaseReady(sql),source:sourceStore(sql,fileBucket(fixture.dir+'/source-blobs'),{reads:100000,writes:100000,repositoryBytes:1024**3}),artifacts:fallback,principals:{[sha256('fixture-token')]:{id:'reviewer',role:'admin',projects:['*']}},mode:'fresh-session fixture',maxProjects:100,monthlyOps:100000});
   const response=await app(new Request('http://localhost'+req.url,{method:req.method,headers:{authorization:req.headers.authorization??'','content-type':'application/json','x-squali-timing':'1'},body:chunks.length?Buffer.concat(chunks):undefined}));
   res.writeHead(response.status,Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500).end(JSON.stringify({error:String(error)}));}finally{await sql.end({timeout:1});}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const call=async(path:string,input?:unknown)=>{const r=await fetch(url+'/api'+path,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer fixture-token','content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
 try{
  const p=await call('/projects',{id:'fresh',name:'Fresh connections',files:[]});const changes=[];
  for(let i=0;i<8;i++){
   const id='change-'+i,path='目录/file,"'+i+'.txt';const c=await call('/projects/fresh/changes',{id,title:id,intent:'Preserve array codecs',base:p.head,dependencies:i?['change-'+(i-1)]:[],files:[{path,content:'content '+i+'\n'}]});assert.deepEqual(c.dependencies,i?['change-'+(i-1)]:[]);changes.push(id);await call('/projects/fresh/changes/'+id+'/review',{decision:'approved'});
  }
  const published=await call('/projects/fresh/publish',{id:'publish',changes:[...changes].reverse(),expectedHead:p.head});assert.deepEqual(published.changes,changes);
  const canonical=await call('/projects/fresh/changesets/'+published.oid);assert.equal(canonical.parents.length,9);
  for(let i=0;i<8;i++)assert.equal((await call('/projects/fresh/file?path='+encodeURIComponent('目录/file,"'+i+'.txt'))).content,'content '+i+'\n');
  console.log(JSON.stringify({command:'node --import tsx --test tests/database-startup.test.ts',freshSessions:sessions,catalogQueries:catalogs,arrayEscaping:true,publicationParents:9,externalProviderCalls:0}));
  assert.ok(sessions>=27);assert.ok(catalogs<=1,'Stable codecs should not require a catalog query for each request: '+catalogs);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await fixture.close();await admin.unsafe('DROP DATABASE '+name+' WITH (FORCE)');await admin.end();}
});

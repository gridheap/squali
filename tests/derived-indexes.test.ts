import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

// Failure specification: graph/path indexes bypass versioned derivation;
// rebuilding a head needs a caller to enumerate every parent; merge parents
// disappear; an empty path delta is mistaken for an unbuilt index; cache loss
// triggers source-blob I/O; eager and lazy answers differ after restart.
test('versioned graph and path derivation rebuilds parent dependencies from one immutable head',async()=>{
 let server=await startLocal({port:0,test:true,source:true,poolSize:1});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
 try{
  const project=await call('/projects',{id:'derived',name:'Derived dependencies',files:[{path:'a.txt',content:'original\n'},{path:'b.txt',content:'original\n'}]});
  const changes=[];for(const path of ['a','b']){changes.push(await call('/projects/derived/changes',{id:path,title:path,intent:'Independent delta',base:project.head,files:[{path:path+'.txt',content:'changed '+path+'\n'}]}));await call('/projects/derived/changes/'+path+'/review',{decision:'approved'});}
  const published=await call('/projects/derived/publish',{id:'publish',changes:['a','b']});
  const before=await call('/projects/derived/path-history?path=a.txt&ref='+published.oid);
  assert.equal(Number((await server.sql`SELECT count(*) FROM weave_derived WHERE project='derived' AND kind='source-paths:v1'`)[0].count),4,'All eager path results use the versioned derivation mechanism');
  const usage=(await call('/usage')).source;
  await server.sql`DELETE FROM weave_derived WHERE project='derived'`;await server.sql`DELETE FROM weave_source_paths WHERE project='derived'`;await server.sql`DELETE FROM weave_commit_graph WHERE project='derived'`;
  const directory=server.dir;await server.close();server=await startLocal({port:0,test:true,source:true,poolSize:1,directory});
  const rebuilt=await call('/projects/derived/source/derive',{kind:'indexes',version:1,changesets:[published.oid]});assert.equal(rebuilt.completed,4);
  assert.equal((await call('/projects/derived/index?ref='+published.oid)).generation,3);
  for(const change of changes)assert.equal((await call('/projects/derived/ancestry',{ancestor:change.oid,descendant:published.oid})).isAncestor,true);
  assert.deepEqual((await call('/projects/derived/path-history?path=a.txt&ref='+published.oid)).commits,before.commits);
  const branch=await call('/projects/derived/path-history?path=a.txt&ref='+changes[0].oid);assert.equal(branch.commits[0].oid,changes[0].oid,'A branch path index can be derived lazily');
  assert.deepEqual((await call('/usage')).source,usage,'Index rebuilding reads canonical metadata without blob I/O');
  const repeat=await call('/projects/derived/source/derive',{kind:'indexes',version:1,changesets:[published.oid]});assert.equal(repeat.completed,0);
  console.log(JSON.stringify({command:'node --import tsx --test tests/derived-indexes.test.ts',eagerAndLazy:true,headOnlyRebuild:true,mergeParentsPreserved:true,processRestart:true,extraBlobReads:0,extraBlobWrites:0}));
 }finally{await server.close();}
});

// Failure specification: a large canonical path delta can exhaust a Worker;
// a missing canonical parent can silently make a non-root look like a root.
test('path derivation rejects oversized or disconnected canonical inputs before marking them complete',async()=>{
 const server=await startLocal({port:0,test:true,source:true});
 const call=async(path:string,body:unknown)=>{const response=await fetch(server.url+'/api'+path,{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
 try{
  const project=(await call('/projects',{id:'bounded-paths',name:'Bounded paths',files:[{path:'a.txt',content:'a\n'}]})).body;
  await server.sql`DELETE FROM weave_derived WHERE project='bounded-paths'`;await server.sql`DELETE FROM weave_source_paths WHERE project='bounded-paths'`;
  await server.sql`UPDATE weave_changesets SET files=${server.sql.json(Array.from({length:100001},(_,i)=>({path:'file-'+i,mode:null,gitOid:null,blob:null})))} WHERE project='bounded-paths'`;
  const large=await call('/projects/bounded-paths/source/derive',{kind:'indexes',version:1,changesets:[project.head]});assert.equal(large.status,422,JSON.stringify(large.body));assert.equal(large.body.error,'derived_budget');
  assert.equal(Number((await server.sql`SELECT count(*) FROM weave_derived WHERE project='bounded-paths'`)[0].count),0);
  await server.sql`UPDATE weave_changesets SET files='[]',parents=${['f'.repeat(64)]} WHERE project='bounded-paths'`;
  const disconnected=await call('/projects/bounded-paths/source/derive',{kind:'indexes',version:1,changesets:[project.head]});assert.equal(disconnected.status,409,JSON.stringify(disconnected.body));assert.equal(disconnected.body.error,'derived_input');
  console.log(JSON.stringify({command:'node --import tsx --test tests/derived-indexes.test.ts',oversizedDeltaRejected:true,missingParentRejected:true,incompleteMarkerPublished:false}));
 }finally{await server.close();}
});

// Failure specification: unifying derived answers discards valid cache entries,
// changes line origins through an edited rename, or re-fetches a cached parent.
test('blame dependency rebuilding preserves native line origins and existing versioned cache entries',async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const exec=promisify(execFile);
 const server=await startLocal({port:0,test:true,source:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json() as any;assert.ok(r.ok,JSON.stringify(value));return value;};
 try{
  const original=Array.from({length:20},(_,i)=>'original line '+i).join('\n')+'\n';
  const p=await call('/projects',{id:'blame-derived',name:'Blame dependencies',files:[{path:'README',content:original}]});
  const c=await call('/projects/blame-derived/changes',{id:'rename',title:'Rename and edit',intent:'Retain prior line origins',base:p.head,files:[{path:'README',content:null},{path:'README.md',content:original+'added line\n'}]});await call('/projects/blame-derived/changes/rename/review',{decision:'approved'});const head=(await call('/projects/blame-derived/publish',{id:'publish',changes:['rename']})).oid;
  const native=server.dir+'/blame.git';await exec('git',['-c','http.extraHeader=Authorization: Bearer local-admin-test-token','clone','--mirror',server.url+'/api/projects/blame-derived/git',native]);
  const raw=(await exec('git',['--git-dir',native,'blame','--root','--line-porcelain',head,'--','README.md'])).stdout,expected=[...raw.matchAll(/^([a-f0-9]{40}) (\d+) \d+(?: \d+)?$/gm)].map(m=>[m[1],Number(m[2])]);
  const first=await call('/projects/blame-derived/blame?path=README.md&ref='+head);assert.deepEqual(first.lines.map((l:any)=>[l.commit,l.originalLine]),expected);
  const cached=(await server.sql`SELECT key,value FROM weave_derived WHERE project='blame-derived' AND kind='blame-renames-v4'`);assert.ok(cached.length>=3,'Blame persists reusable parent results');
  const usage=(await call('/usage')).source;
  await server.sql`DELETE FROM weave_derived WHERE project='blame-derived' AND kind='blame-renames-v4' AND key LIKE ${head+':%'}`;
  const rebuilt=await call('/projects/blame-derived/blame?path=README.md&ref='+head);assert.deepEqual(rebuilt,first);const after=(await call('/usage')).source;assert.ok(after.reads-usage.reads<=2,'Only the current file and edited-rename candidate may be fetched; parent line results are cached');assert.equal(after.writes,usage.writes);await call('/projects/blame-derived/blame?path=README.md&ref='+head);assert.deepEqual((await call('/usage')).source,after,'A complete cached result adds no source I/O');
  console.log(JSON.stringify({command:'node --import tsx --test tests/derived-indexes.test.ts',recursiveBlame:true,editedRenameMatchesGit:true,parentCacheReused:true,currentCacheVersionReused:true}));
 }finally{await server.close();}
});

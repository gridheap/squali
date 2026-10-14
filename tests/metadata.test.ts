import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startLocal} from '../scripts/local.ts';

test('server metadata answers ancestry, merge bases, diff, history, blame, bisect and reviewed revert without checkout',async()=>{
 const server=await startLocal({port:0,test:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const root=(await call('/projects',{id:'meta',name:'Metadata',files:[{path:'src/value.txt',content:'one\ntwo\nthree\n'},{path:'docs/readme.md',content:'stable\n'}]})).body.head;
  const a=(await call('/projects/meta/changes',{id:'left',title:'Left',intent:'Change line one',base:root,files:[{path:'src/value.txt',content:'ONE\ntwo\nthree\n'}]})).body;
  const b=(await call('/projects/meta/changes',{id:'right',title:'Right',intent:'Change line three',base:root,files:[{path:'src/value.txt',content:'one\ntwo\nTHREE\n'}]})).body;
  const search=await call('/projects/meta/search?ref='+root+'&query=readme');assert.equal(search.status,200);assert.deepEqual(search.body.matches.map((r:any)=>r.path),['docs/readme.md']);
  const merge=await call('/projects/meta/merge-base',{left:a.oid,right:b.oid});assert.equal(merge.status,200);assert.deepEqual(merge.body.bases,[root]);
  for(const id of ['left','right'])await call('/projects/meta/changes/'+id+'/review',{decision:'approved'});
  const published=(await call('/projects/meta/publish',{id:'both',changes:['left','right']})).body;const head=published.oid;
  assert.equal((await call('/projects/meta/ancestry',{ancestor:a.oid,descendant:head})).body.isAncestor,true);
  assert.equal((await call('/projects/meta/ancestry',{ancestor:a.oid,descendant:b.oid})).body.isAncestor,false);
  const diff=await call('/projects/meta/diff',{from:root,to:head});assert.equal(diff.status,200);assert.deepEqual(diff.body.files.map((f:any)=>f.path),['src/value.txt']);assert.equal(diff.body.files[0].after,'ONE\ntwo\nTHREE\n');
  const history=await call('/projects/meta/path-history?ref='+head+'&path=src/value.txt&limit=1');assert.equal(history.body.commits[0].oid,head);assert.equal(history.body.next,root);assert.equal(history.body.order,'first-parent');
  const older=await call('/projects/meta/path-history?ref='+history.body.next+'&path=src/value.txt');assert.equal(older.body.commits[0].oid,root);
  const blame=await call('/projects/meta/blame?ref='+head+'&path=src/value.txt');assert.equal(blame.status,200,JSON.stringify(blame.body));assert.deepEqual(blame.body.lines.map((l:any)=>l.commit),[a.oid,root,b.oid]);assert.deepEqual(blame.body.lines.map((l:any)=>l.text),['ONE','two','THREE']);
  const usage=(await call('/usage')).body.attempts;assert.deepEqual((await call('/projects/meta/blame?ref='+head+'&path=src/value.txt')).body,blame.body);assert.equal((await call('/usage')).body.attempts,usage,'Derived blame is reused without Git reads');
  const bisect=await call('/projects/meta/bisect',{good:root,bad:head});assert.equal(bisect.status,200);assert.equal(bisect.body.culprit,head);assert.equal(bisect.body.order,'first-parent');
  const revert=await call('/projects/meta/revert',{id:'undo-both',commit:head});assert.equal(revert.status,201,JSON.stringify(revert.body));assert.equal(revert.body.status,'proposed');assert.equal((await call('/projects/meta/file?path=src/value.txt')).body.content,'ONE\ntwo\nTHREE\n','Revert still requires review');
  await call('/projects/meta/changes/undo-both/review',{decision:'approved'});await call('/projects/meta/publish',{id:'undo',changes:['undo-both']});assert.equal((await call('/projects/meta/file?path=src/value.txt')).body.content,'one\ntwo\nthree\n');
  console.log(JSON.stringify({command:'pnpm test:metadata',mergeBase:root,mergedHead:head,blameCommits:blame.body.lines.map((l:any)=>l.commit),derivedReplayProviderCalls:0,revertRequiresReview:true}));
 }finally{await server.close();}
});

test('search pages resume across SQL JSON ordering and bind cursors to immutable queries',async()=>{
 const server=await startLocal({port:0,test:true});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};};
 try{
  const p=await call('/projects',{id:'search-pages',name:'Search pages',files:Array.from({length:60},(_,i)=>({path:`src/file-${String(i).padStart(2,'0')}.txt`,content:'x'}))});assert.equal(p.status,201);
  const first=await call('/projects/search-pages/search?ref='+p.body.head+'&query=file');assert.equal(first.status,200);assert.equal(first.body.matches.length,50);assert.ok(first.body.next);
  const next=await call('/projects/search-pages/search?ref='+p.body.head+'&query=file&cursor='+first.body.next);assert.equal(next.status,200,JSON.stringify(next.body));assert.equal(next.body.matches.length,10);assert.equal(next.body.next,null);assert.equal(new Set([...first.body.matches,...next.body.matches].map(x=>x.path)).size,60);
  assert.equal((await call('/projects/search-pages/search?ref='+p.body.head+'&query=other&cursor='+first.body.next)).status,400);
  console.log(JSON.stringify({command:'pnpm test:metadata',searchPages:[50,10],uniqueMatches:60,queryBoundCursor:true}));
 }finally{await server.close();}
});

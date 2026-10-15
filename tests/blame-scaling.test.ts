import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {startLocal} from '../scripts/local.ts';

// Failure specification: unrelated commits multiply cold blame SQL round trips;
// skipping them loses a merge-parent origin or crosses a delete/re-add boundary;
// cached replay reads source bodies again. Compare full origins with native Git
// through the authenticated HTTP entry point, using local storage only.
test('cold blame batches metadata for a changing file across unrelated history',{timeout:60000},async()=>{
 const exec=promisify(execFile);let queries:string[]=[];
 const server=await startLocal({port:0,test:true,source:true,poolSize:1,onQuery:q=>queries.push(q)});
 const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 try{
  const native=server.dir+'/native.git';await exec('git',['init','--bare',native]);
  let data='';
  for(let i=1;i<=128;i++){
   const body='other '+i+'\n';data+=`blob\nmark :${1000+i}\ndata ${Buffer.byteLength(body)}\n${body}\n`;
   if(i%8===1){const text='stable first\nrevision '+Math.floor(i/8)+'\nstable last\n';data+=`blob\nmark :${2000+i}\ndata ${Buffer.byteLength(text)}\n${text}\n`;}
   data+=`commit refs/heads/main\nmark :${i}\ncommitter Fixture <fixture@example.invalid> ${1700000000+i} +0000\ndata ${Buffer.byteLength('commit '+i)}\ncommit ${i}\n${i>1?'from :'+(i-1)+'\n':''}M 100644 :${1000+i} unrelated.txt\n${i%8===1?'M 100644 :'+(2000+i)+' README.md\n':''}\n`;
  }
  const importer=spawn('git',['--git-dir',native,'fast-import','--quiet']);let errors='';importer.stderr.on('data',b=>errors+=b);importer.stdin.end(data);await new Promise<void>((ok,fail)=>importer.on('close',c=>c===0?ok():fail(Error(errors))));
  const create=await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'blame-scale',name:'Blame scaling',storage:'source',import:true,files:[]})});assert.equal(create.status,201,await create.text());
  await exec('python3',['scripts/import-source.py','blame-scale',native,'--state',server.dir+'/state'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  const head=(await exec('git',['--git-dir',native,'rev-parse','main'])).stdout.trim();
  const nativeBlame=(await exec('git',['--git-dir',native,'blame','--root','--line-porcelain',head,'--','README.md'])).stdout;
  const expected=[...nativeBlame.matchAll(/^([a-f0-9]{40}) (\d+) \d+(?: \d+)?$/gm)].map(m=>[m[1],Number(m[2])]);
  queries=[];const start=performance.now();const response=await fetch(server.url+'/api/projects/blame-scale/blame?path=README.md&ref='+head,{headers});const value=await response.json() as any;const coldQueries=queries.length;
  const families=Object.fromEntries(['weave_commit_graph','weave_derived','weave_source_paths','weave_changesets','weave_source_objects'].map(table=>[table,queries.filter(q=>q.includes(table)).length]));
  console.log(JSON.stringify({command:'node --import tsx --test tests/blame-scaling.test.ts',commits:128,fileChanges:16,coldSql:coldQueries,elapsedMs:Math.round(performance.now()-start),families,status:response.status}));
  assert.equal(response.status,200,JSON.stringify(value));assert.deepEqual(value.lines.map((l:any)=>[l.commit,l.originalLine]),expected);
  assert.ok(coldQueries<=100,`Sixteen file revisions in 128 commits must stay within 100 SQL statements; observed ${coldQueries}`);
  const before=await fetch(server.url+'/api/usage',{headers}).then(r=>r.json());
  const warm=await fetch(server.url+'/api/projects/blame-scale/blame?path=README.md&ref='+head,{headers}).then(r=>r.json());assert.deepEqual(warm,value);
  assert.deepEqual(await fetch(server.url+'/api/usage',{headers}).then(r=>r.json()),before);
 }finally{await server.close();}
});

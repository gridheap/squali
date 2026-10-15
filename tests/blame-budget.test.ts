import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';

// Failure specification: repeated small edits charge a quadratic whole-file
// comparison, reject ordinary history, or change native line origins after
// trimming unchanged boundaries. Warm replay must reuse the saved result.
test('blame compares only changed regions across a long stable file history',{timeout:60000},async()=>{
 const exec=promisify(execFile),server=await startLocal({port:0,test:true,source:true});
 const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const get=async(path:string)=>{const r=await fetch(server.url+'/api'+path,{headers});const v=await r.json() as any;assert.equal(r.status,200,JSON.stringify(v));return v;};
 try{
  const native=server.dir+'/native';await exec('git',['init','--initial-branch=main',native]);const git=(...args:string[])=>exec('git',['-C',native,...args]);await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  const initial=Array.from({length:500},(_,i)=>'Stable line '+i);
  for(let n=0;n<20;n++){const lines=[...initial];lines.splice(0,n%3,'Revision '+n,'Repeated','Repeated');await writeFile(native+'/README.md',lines.join('\n')+'\n');await git('add','.');await git('commit','-m','Revision '+n);}
  await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'blame-budget',name:'Long stable file',storage:'source',import:true,files:[]})});
  await exec('python3',['scripts/import-source.py','blame-budget',native,'--state',server.dir+'/state'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  const head=(await git('rev-parse','HEAD')).stdout.trim(),nativeBlame=(await git('blame','--root','--line-porcelain','HEAD','--','README.md')).stdout;
  const expected=[...nativeBlame.matchAll(/^([a-f0-9]{40}) (\d+) \d+(?: \d+)?$/gm)].map(m=>[m[1],Number(m[2])]);
  const result=await get('/projects/blame-budget/blame?path=README.md&ref='+head);assert.deepEqual(result.lines.map((r:any)=>[r.commit,r.originalLine]),expected);
  const usage=await get('/usage');assert.deepEqual(await get('/projects/blame-budget/blame?path=README.md&ref='+head),result);assert.deepEqual(await get('/usage'),usage);
  console.log(JSON.stringify({command:'node --import tsx --test tests/blame-budget.test.ts',commits:20,lines:result.lines.length,nativeOriginsEqual:true,completedReplayExtraCalls:0}));
 }finally{await server.close();}
});

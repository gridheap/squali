import test from 'node:test';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {writeFile,rename} from 'node:fs/promises';
import {startLocal} from '../scripts/local.ts';
// Failure specification: EOF newline edits retain stale origins; an identical
// second-parent blob loses its whole-file attribution; a rename through a
// non-first merge parent disappears; repeated blank lines get arbitrary origins.
for(const scenario of ['newline','identical-parent','rename-parent','blank-lines'])test('native blame origins: '+scenario,{timeout:30000},async()=>{
 const exec=promisify(execFile),server=await startLocal({port:0,test:true,source:true}),native=server.dir+'/native';
 const headers={authorization:'Bearer local-admin-test-token','content-type':'application/json'};
 const git=async(...args:string[])=>(await exec('git',['-C',native,...args])).stdout.trim();
 try{
  await exec('git',['init','--initial-branch=main',native]);await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  const save=async(path:string,content:string,message:string)=>{await writeFile(native+'/'+path,content);await git('add','-A');await git('commit','-m',message);return git('rev-parse','HEAD');};let path='file.txt';
  if(scenario==='newline'){await save(path,'A','no newline');await save(path,'A\n','add newline');}
  else if(scenario==='blank-lines'){let seed=19;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};for(let c=0;c<18;c++){const lines=Array.from({length:24},()=>['A','B','','  C','}'][random()%5]);await save(path,lines.join('\n')+'\n','revision '+c);}}
  else{
   const old=scenario==='rename-parent'?'old.txt':path;const root=await save(old,'base one\nbase two\nbase three\nbase four\n','root');
   let left:string,right:string;
   if(scenario==='rename-parent'){await rename(native+'/old.txt',native+'/file.txt');left=await save(path,'base one\nbase two\nbase three\nbase four\n','rename');await git('checkout','-b','right',root);right=await save(old,'base one\nright edit\nbase three\nbase four\n','right edit');await git('checkout','main');await writeFile(native+'/'+path,'base one\nright edit\nbase three\nbase four\n');}
   else{left=await save(path,'shared\nleft\n','left');await git('checkout','-b','right',root);right=await save(path,'shared\nright\n','right');}
   await git('add','-A');const tree=await git('write-tree'),merge=await git('commit-tree',tree,'-p',left,'-p',right,'-m','merge');await git('update-ref','refs/heads/main',merge);await git('checkout','main');
  }
  const head=await git('rev-parse','main');await fetch(server.url+'/api/projects',{method:'POST',headers,body:JSON.stringify({id:'native-blame',name:scenario,storage:'source',import:true,files:[]})});
  await exec('python3',['scripts/import-source.py','native-blame',native,'--state',server.dir+'/state'],{env:{...process.env,SQUALI_URL:server.url,SQUALI_TOKEN:'local-admin-test-token'}});
  const response=await fetch(server.url+'/api/projects/native-blame/blame?path='+path+'&ref='+head,{headers}),value=await response.json() as any;assert.equal(response.status,200,JSON.stringify(value));
  const nativeBlame=await git('blame','--root','--line-porcelain',head,'--',path),origins=[...nativeBlame.matchAll(/^([a-f0-9]{40}) (\d+) \d+(?: \d+)?$/gm)].map(m=>[m[1],Number(m[2])]);assert.deepEqual(value.lines.map((r:any)=>[r.commit,r.originalLine]),origins);
  console.log(JSON.stringify({command:'node --import tsx --test tests/blame-native.test.ts',scenario,lines:origins.length,nativeOriginsEqual:true}));
 }finally{await server.close();}
});

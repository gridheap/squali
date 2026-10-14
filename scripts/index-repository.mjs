#!/usr/bin/env node
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const [project,directory,ref,...options]=process.argv.slice(2);
const base=(process.env.SQUALI_URL??'http://127.0.0.1:8787').replace(/\/$/,'');
const token=process.env.SQUALI_TOKEN;
if(!token||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(project??'')||!directory||!/^[a-f0-9]{40}$/.test(ref??''))throw Error('Set SQUALI_TOKEN, then use: index-repository.mjs <project> <local-repository> <commit-id> [--max-steps N] [--max-commits N]');
let maxSteps=1,maxCommits=10000;
for(let i=0;i<options.length;i+=2){const n=Number(options[i+1]);if(!Number.isInteger(n)||n<1)throw Error('Budgets must be positive integers');if(options[i]==='--max-steps'&&n<=1000)maxSteps=n;else if(options[i]==='--max-commits'&&n<=100000)maxCommits=n;else throw Error('Unknown option or excessive budget');}
const started=Date.now();
async function call(path,body){if(Date.now()-started>15*60*1000)throw Error('Fifteen-minute indexing limit reached; progress is saved');const response=await fetch(base+'/api/projects/'+project+'/index'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const value=await response.json();if(!response.ok)throw Error(value.message??'Index request failed');return value;}
async function rawCommits(ids){
 const child=spawn('git',['-C',directory,'cat-file','--batch']);const chunks=[];let size=0;
 child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)child.kill();else chunks.push(chunk);});child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(ids.join('\n')+'\n');
 await new Promise((done,fail)=>{const timer=setTimeout(()=>child.kill(),30000);child.once('error',error=>{clearTimeout(timer);fail(error);});child.once('close',code=>{clearTimeout(timer);code===0?done():fail(Error('Bounded native Git export failed'));});});
 const bytes=Buffer.concat(chunks),records=[];let offset=0;
 while(offset<bytes.length){const end=bytes.indexOf(10,offset);if(end<0)throw Error('Invalid Git batch output');const [oid,type,length]=bytes.subarray(offset,end).toString().split(' ');const n=Number(length);offset=end+1;if(type!=='commit'||!Number.isSafeInteger(n)||n<1||n>1024*1024||offset+n>=bytes.length)throw Error('Invalid or oversized Git commit');records.push({oid,body:bytes.subarray(offset,offset+n).toString('base64'),bytes:n});offset+=n+1;}
 if(records.length!==ids.length)throw Error('Incomplete Git metadata export');return records;
}
const status=await call('?ref='+ref);
if(status.complete){console.log(JSON.stringify({...status,skipped:true,accepted:0,steps:0}));}
else{
 const ids=(await exec('git',['-C',directory,'rev-list','--topo-order','--max-count='+String(maxCommits+1),ref],{maxBuffer:5*1024*1024,timeout:30000})).stdout.trim().split('\n');
 if(ids.length>maxCommits)throw Error('Source exceeds the explicit commit budget; nothing was uploaded');
 let accepted=0,uploadedBytes=0,requests=0;
 for(let offset=0;offset<ids.length;offset+=128){
  const records=await rawCommits(ids.slice(offset,offset+128));let batch=[],size=0;
  async function upload(){if(!batch.length)return;uploadedBytes+=size;if(uploadedBytes>128*1024*1024)throw Error('128 MiB metadata upload limit reached');const result=await call('/commits',{ref,commits:batch.map(({oid,body})=>({oid,body}))});accepted+=result.accepted;requests++;batch=[];size=0;}
  for(const record of records){if(size+record.bytes>1024*1024)await upload();batch.push(record);size+=record.bytes;}await upload();
 }
 let result=status,steps=0;
 while(!result.complete&&steps<maxSteps){result=await call('',{ref,limit:128});steps++;}
 console.log(JSON.stringify({...result,sourceCommits:ids.length,accepted,uploadedBytes,uploadRequests:requests,steps,maxSteps,elapsedMs:Date.now()-started}));
 if(!result.complete)process.exitCode=2;
}

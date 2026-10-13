#!/usr/bin/env node
const [command,project,id]=process.argv.slice(2);
const base=process.env.SQUALI_URL??process.env.WEAVE_URL??'http://127.0.0.1:8787';
const token=process.env.SQUALI_TOKEN??process.env.WEAVE_TOKEN;
if(!token)throw new Error('Set SQUALI_TOKEN in your environment. Never pass credentials as command arguments.');
const enc=encodeURIComponent;
const routes={projects:'/projects',create:'/projects',changes:`/projects/${enc(project??'')}/changes`,propose:`/projects/${enc(project??'')}/changes`,show:`/projects/${enc(project??'')}/changes/${enc(id??'')}`,review:`/projects/${enc(project??'')}/changes/${enc(id??'')}/review`,revise:`/projects/${enc(project??'')}/changes/${enc(id??'')}/revise`,preview:`/projects/${enc(project??'')}/preview`,publish:`/projects/${enc(project??'')}/publish`,usage:'/usage',events:`/projects/${enc(project??'')}/events`,file:`/projects/${enc(project??'')}/file?path=${enc(id??'')}`,tree:`/projects/${enc(project??'')}/tree?path=${enc(id??'')}`};
if(!routes[command])throw new Error('Usage: node scripts/squali.mjs projects|create|changes|propose|show|review|revise|preview|publish|events|file|tree|usage [project] [change-id or path]. Mutations read JSON from stdin.');
const mutating=['create','propose','review','revise','preview','publish'].includes(command);
let body;if(mutating){const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);body=Buffer.concat(chunks).toString('utf8');}
if(body)JSON.parse(body);
const response=await fetch(base.replace(/\/$/,'')+'/api'+routes[command],{method:mutating?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body,signal:AbortSignal.timeout(30000)});
console.log(JSON.stringify(await response.json(),null,2));
if(!response.ok)process.exitCode=1;

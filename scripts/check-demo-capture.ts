import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]??'work/continuous-demo');
const record=JSON.parse(await readFile(root+'/recording.json','utf8'));
const failures:string[]=[];
try{
 assert.equal(record.success,true);assert.equal(record.events.length,8);assert.ok(record.frames.length>0&&record.frames.length<=4000);
 assert.ok(record.frames[0].timeSeconds<1,'Begin capture with the usable application');
 for(const scene of record.events){
  assert.ok(Number.isFinite(scene.visualReadySeconds),`Scene ${scene.scene}: missing visual checkpoint`);
  assert.ok(record.frames.some((frame:any)=>frame.timeSeconds>=scene.visualReadySeconds&&frame.timeSeconds<=scene.endSeconds),`Scene ${scene.scene}: no retained frame of the completed actions`);
 }
 assert.equal(record.events.at(-1).view,'retained-production-verification');
 for(let i=1;i<record.frames.length;i++)assert.ok(record.frames[i].timeSeconds-record.frames[i-1].timeSeconds<2,'Continuous sampling has a gap above two seconds');
}catch(error){failures.push(String(error));}
const report={command:'node --import tsx scripts/check-demo-capture.ts '+process.argv[2],success:failures.length===0,frames:record.frames.length,durationSeconds:record.durationSeconds,failures};
await writeFile(root+'/capture-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assert.equal(failures.length,0,failures.join('\n'));

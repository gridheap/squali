import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {gitLineDiff,gitLines} from '../src/git-line-diff.ts';
// Isolated algorithm failure specification: repeated/blank lines select different
// origins than Git; EOF newline identity disappears; prefix/suffix trimming,
// discarded common lines, Myers splits or indent compaction change hunks;
// large disjoint/repeated inputs exceed the shared CPU or allocation budget.
test('bounded line diff matches native Git Myers and indent compaction',{timeout:30000},async()=>{
 const dir=await mkdtemp(tmpdir()+'/squali-diff-');let seed=519;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const alphabet=['A\n','B\n','\n','  C\n','}\n','\tD\n'];
 const cases:[string,string][]=[['A','A\n'],['','x\n'],['x\n',''],['B\nA\n','A\nA\n']];
 for(let n=0;n<128;n++){const a=Array.from({length:random()%50},()=>alphabet[random()%alphabet.length]);const b=Array.from({length:random()%50},()=>alphabet[random()%alphabet.length]);cases.push([a.join(''),b.join('')]);}
 // A blank separator between short replacements must not be pruned.
 cases.push(["record 0\nrecord 1\n\nrecord 2\n\n record 3\n   record 4\n   record 5\n record 6\n   record 7\n record 8\n   record 9\n record 10\n\nrecord 11\nrecord 12\nrecord 13\n\nrecord 14\nrecord 15\nrecord 16\nrecord 17\nrecord 18\n\nrecord 19\nrecord 20\nrecord 21\n", "\n\n\n\nrecord 17\n\n\n\n\n"]);
 // Force the expensive split heuristic and repeated-line cleanup, not only small LCS cases.
 cases.push([Array.from({length:700},(_,i)=>'left '+i+'\n').join(''),Array.from({length:700},(_,i)=>'right '+i+'\n').join('')]);
 cases.push([Array.from({length:700},(_,i)=>i%19?'\n':'old '+i+'\n').join(''),Array.from({length:710},(_,i)=>i%17?'\n':'new '+i+'\n').join('')]);
 try{for(const [left,right]of cases){await writeFile(dir+'/a',left);await writeFile(dir+'/b',right);let out='';try{out=execFileSync('git',['-c','diff.external=','diff','--no-index','--no-ext-diff','--no-textconv','--diff-algorithm=myers','--indent-heuristic','-U0','--',dir+'/a',dir+'/b'],{encoding:'utf8'});}catch(error:any){assert.equal(error.status,1);out=error.stdout;}
  const native=[...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m=>{const a=Number(m[2]??1),b=Number(m[4]??1);return [Number(m[1])-(a?1:0),a,Number(m[3])-(b?1:0),b];});let work=0;
  const actual=gitLineDiff(gitLines(left),gitLines(right),n=>{work+=n;assert.ok(work<4000000);}).map(h=>[...h.buffer1,...h.buffer2]);assert.deepEqual(actual,native,JSON.stringify({left,right}));
 }
 let remaining=50;assert.throws(()=>gitLineDiff(Array(2000).fill('A\n'),Array(2000).fill('B\n'),n=>{remaining-=n;if(remaining<0)throw Error('budget');}),/budget/);
 console.log(JSON.stringify({command:'node --import tsx --test tests/git-line-diff.test.ts',nativeCases:cases.length,sharedBudget:true}));
 }finally{await rm(dir,{recursive:true,force:true});}
});

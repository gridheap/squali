/* SPDX-License-Identifier: Apache-2.0
 * TypeScript adaptation of imara-diff by Pascal Kuthe and contributors.
 * Upstream revision f02e46a737c43c0d9c65a42e5e08046bd10fd739.
 * Adaptation and compatibility fixes Copyright (c) 2026 Grid Heap.
 * See licenses/imara-diff.md and licenses/Apache-2.0.txt.
 */
import type {LineHunk} from './git-line-diff.ts';

type Charge=(units:number)=>void;
type Range={start:number;end:number};
type Hunk={before:Range;after:Range};
type Prepared={tokens:number[];indices:number[];changed:Uint8Array};
type Slice={file:Prepared;start:number;end:number};
type Split={x:number;y:number;minimalBefore:boolean;minimalAfter:boolean};

// Frequencies count the complete inputs, including their common edges.
const approximateRoot=(n:number)=>2**Math.ceil((n===0?0:32-Math.clz32(n))/2);

function preprocess(tokens:number[],otherCounts:number[],start:number,end:number,charge:Charge):Prepared{
 const limit=Math.min(approximateRoot(tokens.length),1024);
 const status=tokens.map(token=>{charge(1);const count=otherCounts[token]??0;return count===0?0:count>=limit?2:1;});
 const file:Prepared={tokens:[],indices:[],changed:new Uint8Array(tokens.length)};
 function pruneCommon(pos:number){
  // Include the candidate in both neighboring contexts. Otherwise a single
  // separator between short replacements is classified as disposable noise.
  let unmatchedBefore=0,commonBefore=1,unmatchedAfter=0,commonAfter=0;
  for(let i=pos-1;i>=Math.max(start,pos-100);i--){charge(1);if(status[i]===0)unmatchedBefore++;else if(status[i]===2)commonBefore++;else break;}
  if(unmatchedBefore===0)return false;
  for(let i=pos;i<Math.min(end,pos+100);i++){charge(1);if(status[i]===0)unmatchedAfter++;else if(status[i]===2)commonAfter++;else break;}
  return unmatchedAfter>0&&unmatchedBefore+unmatchedAfter>3*(commonBefore+commonAfter);
 }
 for(let i=start;i<end;i++){
  charge(1);
  if(status[i]===0||status[i]===2&&pruneCommon(i))file.changed[i]=1;
  else {file.tokens.push(tokens[i]);file.indices.push(i);}
 }
 return file;
}

/** Bidirectional middle-snake search, with the upstream bounded-cost heuristic. */
class SnakeSearch{
 readonly data:Int32Array;readonly offset:number;readonly min:number;readonly max:number;
 low:number;high:number;
 constructor(readonly backwards:boolean,readonly a:Slice,readonly b:Slice,readonly charge:Charge){
  this.min=-(b.end-b.start);this.max=a.end-a.start;
  this.offset=-this.min+1;this.data=new Int32Array(this.max-this.min+3);
  this.low=this.high=backwards?this.min+this.max:0;
  this.set(this.low,backwards?this.max:0);
 }
 get(k:number){return this.data[this.offset+k];}
 set(k:number,x:number){this.data[this.offset+k]=x;}
 contains(k:number){return k>=this.low&&k<=this.high;}
 extend(){
  const sentinel=this.backwards?0x7fffffff:-0x7fffffff;
  if(this.low>this.min){this.low--;this.set(this.low-1,sentinel);}else this.low++;
  if(this.high<this.max){this.high++;this.set(this.high+1,sentinel);}else this.high--;
 }
 run(crosses:(k:number,x:number)=>boolean):{found?:[number,number];snake:boolean}{
  let snake=false;
  for(let k=this.high;k>=this.low;k-=2){
   this.charge(1);
   let x=this.backwards?(this.get(k-1)<this.get(k+1)?this.get(k-1):this.get(k+1)-1)
    :(this.get(k-1)>=this.get(k+1)?this.get(k-1)+1:this.get(k+1));
   let y=x-k,matched=0;
   if(this.backwards){
    while(x>0&&y>0&&this.a.file.tokens[this.a.start+x-1]===this.b.file.tokens[this.b.start+y-1]){this.charge(1);x--;y--;matched++;}
   }else{
    while(x<this.max&&y<-this.min&&this.a.file.tokens[this.a.start+x]===this.b.file.tokens[this.b.start+y]){this.charge(1);x++;y++;matched++;}
   }
   snake ||= matched>20;this.set(k,x);
   if(crosses(k,x))return {found:[x,y],snake};
  }
  return {snake};
 }
 bestPosition():[number,number]{
  let distance=this.backwards?Number.MAX_SAFE_INTEGER:-1,bestX=this.backwards?Number.MAX_SAFE_INTEGER:-1;
  for(let k=this.high;k>=this.low;k-=2){
   this.charge(1);let x=this.backwards?Math.max(0,this.get(k)):Math.min(this.max,this.get(k)),y=x-k;
   if(this.backwards&&y<0){x=k;y=0;}else if(!this.backwards&&y>-this.min){y=-this.min;x=y+k;}
   if(this.backwards?x+y<distance:x+y>distance){distance=x+y;bestX=x;}
  }
  return [distance,bestX];
 }
 goodSnake(cost:number):[number,number]|undefined{
  let bestScore=0,result:[number,number]|undefined;
  for(let k=this.high;k>=this.low;k-=2){
   this.charge(1);const x=this.get(k),y=x-k;
   if(this.backwards?(x<0||x>=this.max-20||y<0||y>=-this.min-20):(x<20||x>=this.max||y<20||y>=-this.min))continue;
   const distance=this.backwards?this.max-x-this.min-y:x+y,score=distance+Math.abs(k);
   if(score<=4*cost||score<=bestScore)continue;
   let matches=true;
   for(let i=0;i<20;i++){
    this.charge(1);const delta=this.backwards?i:-i-1;
    if(this.a.file.tokens[this.a.start+x+delta]!==this.b.file.tokens[this.b.start+y+delta]){matches=false;break;}
   }
   if(matches){bestScore=score;result=[x,y];}
  }
  return result;
 }
}

function split(a:Slice,b:Slice,minimal:boolean,maxCost:number,charge:Charge):Split{
 const forward=new SnakeSearch(false,a,b,charge),backward=new SnakeSearch(true,a,b,charge);
 const odd=((a.end-a.start)-(b.end-b.start))%2!==0;
 for(let cost=0;;cost++){
  charge(1);forward.extend();
  const f=forward.run((k,x)=>odd&&backward.contains(k)&&backward.get(k)<=x);
  if(f.found)return {x:f.found[0],y:f.found[1],minimalBefore:true,minimalAfter:true};
  backward.extend();const result=backward.run((k,x)=>!odd&&forward.contains(k)&&x<=forward.get(k));
  if(result.found)return {x:result.found[0],y:result.found[1],minimalBefore:true,minimalAfter:true};
  if(minimal)continue;
  if((f.snake||result.snake)&&cost>256){
   const ahead=forward.goodSnake(cost);if(ahead)return {x:ahead[0],y:ahead[1],minimalBefore:true,minimalAfter:false};
   const behind=backward.goodSnake(cost);if(behind)return {x:behind[0],y:behind[1],minimalBefore:false,minimalAfter:true};
  }
  if(cost>=maxCost)break;
 }
 const [fd,fx]=forward.bestPosition(),[bd,bx]=backward.bestPosition();
 return fd>(a.end-a.start)+(b.end-b.start)-bd
  ?{x:fx,y:fd-fx,minimalBefore:true,minimalAfter:false}
  :{x:bx,y:bd-bx,minimalBefore:false,minimalAfter:true};
}

function myers(before:Prepared,after:Prepared,charge:Charge){
 const maxCost=Math.max(256,approximateRoot(before.tokens.length+after.tokens.length+3));
 const pending:{a:Slice;b:Slice;minimal:boolean}[]=[{a:{file:before,start:0,end:before.tokens.length},b:{file:after,start:0,end:after.tokens.length},minimal:false}];
 while(pending.length){
  const {a,b,minimal}=pending.pop()!;charge(1);
  while(a.start<a.end&&b.start<b.end&&a.file.tokens[a.start]===b.file.tokens[b.start]){charge(1);a.start++;b.start++;}
  while(a.start<a.end&&b.start<b.end&&a.file.tokens[a.end-1]===b.file.tokens[b.end-1]){charge(1);a.end--;b.end--;}
  if(a.start===a.end||b.start===b.end){
   const rest=a.start===a.end?b:a;
   for(let i=rest.start;i<rest.end;i++){charge(1);rest.file.changed[rest.file.indices[i]]=1;}
   continue;
  }
  const point=split(a,b,minimal,maxCost,charge),ax=a.start+point.x,by=b.start+point.y;
  // Preserve upstream left-before-right order without recursive stack growth.
  pending.push({a:{...a,start:ax},b:{...b,start:by},minimal:point.minimalAfter});
  pending.push({a:{...a,end:ax},b:{...b,end:by},minimal:point.minimalBefore});
 }
}

class Postprocessor{
 hunk:Hunk={before:{start:0,end:0},after:{start:0,end:0}};
 constructor(readonly removed:Uint8Array,readonly added:Uint8Array,readonly tokens:number[],readonly bestEnd:(hunk:Range,earliest:number)=>number,readonly charge:Charge){}
 end(changes:Uint8Array,pos:number){while(pos<changes.length&&changes[pos]){this.charge(1);pos++;}return pos;}
 start(changes:Uint8Array,pos:number){while(pos>0&&changes[pos-1]){this.charge(1);pos--;}return pos;}
 nextChange(changes:Uint8Array,pos:number){const from=pos;while(pos<changes.length&&!changes[pos]){this.charge(1);pos++;}return pos===changes.length?undefined:pos-from;}
 next(){
  const {before,after}=this.hunk,off=this.nextChange(this.added,after.end);if(off===undefined)return false;
  let consumed=0;
  for(;;){
   this.charge(1);const unchanged=this.nextChange(this.removed,before.end)??this.removed.length-before.end;
   if(consumed+unchanged>off){before.start=before.end+(off-consumed);before.end=before.start;break;}
   consumed+=unchanged;before.start=before.end+unchanged;before.end=this.end(this.removed,before.start);
   if(consumed===off)break;
  }
  after.start=after.end+off;after.end=this.end(this.added,after.start);return true;
 }
 down(){
  this.charge(1);const {before,after}=this.hunk;
  if(after.end>=this.tokens.length||this.tokens[after.start]!==this.tokens[after.end])return false;
  this.added[after.start]=0;this.added[after.end]=1;after.start++;after.end=this.end(this.added,after.end);
  before.start=before.end+1;before.end=this.end(this.removed,before.start);return true;
 }
 up(){
  this.charge(1);const {before,after}=this.hunk;
  if(after.start===0||this.tokens[after.start-1]!==this.tokens[after.end-1])return false;
  this.added[after.start-1]=1;this.added[after.end-1]=0;after.end--;after.start=this.start(this.added,after.start-1);
  before.end=before.start-1;before.start=this.start(this.removed,before.end);return true;
 }
 run(){
  while(this.next()){
   let earliest:number,modification:boolean;
   for(;;){
    while(this.up()){}
    const {before,after}=this.hunk;earliest=after.end;modification=before.start!==before.end;
    const size=after.end-after.start;
    while(this.down())modification ||= before.start!==before.end;
    if(size===after.end-after.start)break;
   }
   const {before,after}=this.hunk;if(after.end===earliest)continue;
   if(modification){while(before.start===before.end){if(!this.up())throw Error('Line comparison hunk cannot align');}}
   else{
    const end=this.bestEnd(after,earliest);
    while(after.end>end){if(!this.up())throw Error('Line comparison hunk cannot slide');}
   }
  }
 }
}

type Score={indent:number;penalty:number};
function indentHeuristic(tokens:number[],indents:number[],charge:Charge){
 function at(index:number):Score{
  charge(1);const eof=index===tokens.length,current=eof?-1:indents[tokens[index]];
  let leading=0,previous=-1,trailing=0,next=-1;
  for(let i=index-1;i>=0;i--){charge(1);if(leading===20){previous=0;break;}previous=indents[tokens[i]];if(previous!==-1)break;leading++;}
  for(let i=index+1;i<tokens.length;i++){charge(1);if(trailing===20){next=0;break;}next=indents[tokens[i]];if(next!==-1)break;trailing++;}
  const blanksAfter=current===-1?trailing+1:0,total=leading+blanksAfter,indent=current===-1?next:current;
  let penalty=(previous===-1&&leading===0?1:0)+(eof?21:0)-30*total+6*blanksAfter;
  if(indent!==-1&&previous!==-1){
   if(indent>previous)penalty+=total!==0?10:-4;
   else if(indent<previous)penalty+=next!==-1&&next<=indent?(total!==0?17:23):(total!==0?17:24);
  }
  return {indent,penalty};
 }
 return (hunk:Range,earliest:number)=>{
  const size=hunk.end-hunk.start,top=Math.max(earliest,hunk.start-1,hunk.end-100);
  const score=(end:number)=>{const a=at(end-size),b=at(end);return {indent:a.indent+b.indent,penalty:a.penalty+b.penalty};};
  let selected=top,best=score(top);
  for(let end=top+1;end<=hunk.end;end++){
   charge(1);const next=score(end);
   if(60*Math.sign(next.indent-best.indent)+next.penalty-best.penalty<=0){selected=end;best=next;}
  }
  return selected;
 };
}

export function compareLines(before:string[],after:string[],charge:Charge):LineHunk[]{
 charge(8*(before.length+after.length)+1);
 const ids=new Map<string,number>(),indents:number[]=[];
 function intern(lines:string[]){return lines.map(line=>{
  charge(1);const known=ids.get(line);if(known!==undefined)return known;
  const id=ids.size;ids.set(line,id);let level=0,blank=true;
  for(const c of line){
   charge(1);
   if(c===' ')level++;else if(c==='\t')level+=8-level%8;
   else if(c!=='\r'&&c!=='\n'&&c!=='\f'&&c!=='\v'){blank=false;break;}
   if(level>=200){level=200;blank=false;break;}
  }
  indents.push(blank?-1:level);return id;
 });}
 const a=intern(before),b=intern(after),countsA:number[]=[],countsB:number[]=[];
 for(const token of a){charge(1);countsA[token]=(countsA[token]??0)+1;}
 for(const token of b){charge(1);countsB[token]=(countsB[token]??0)+1;}
 let prefix=0,suffix=0;
 while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix]){charge(1);prefix++;}
 while(suffix<Math.min(a.length,b.length)-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix]){charge(1);suffix++;}
 const old=preprocess(a,countsB,prefix,a.length-suffix,charge),next=preprocess(b,countsA,prefix,b.length-suffix,charge);
 myers(old,next,charge);
 new Postprocessor(next.changed,old.changed,a,indentHeuristic(a,indents,charge),charge).run();
 new Postprocessor(old.changed,next.changed,b,indentHeuristic(b,indents,charge),charge).run();
 const hunks:LineHunk[]=[];let x=0,y=0;
 while(x<a.length||y<b.length){
  charge(1);
  if(old.changed[x]||next.changed[y]){
   const startX=x,startY=y;
   while(x<a.length&&old.changed[x]){charge(1);x++;}
   while(y<b.length&&next.changed[y]){charge(1);y++;}
   hunks.push({buffer1:[startX,x-startX],buffer2:[startY,y-startY]});
  }else {x++;y++;}
 }
 return hunks;
}

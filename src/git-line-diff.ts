// SPDX-License-Identifier: MIT
import {compareLines} from './imara-line-diff.ts';
export type LineHunk={buffer1:[number,number];buffer2:[number,number]};
export const gitLines=(content:string):string[]=>content.match(/[^\n]*\n|[^\n]+$/g)??[];
export function gitLineDiff(before:string[],after:string[],charge:(units:number)=>void):LineHunk[]{
 if(before.length>2000||after.length>2000)throw Error('Line comparison exceeds 2,000 records');
 return compareLines(before,after,charge);
}

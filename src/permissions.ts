import type {Principal} from './types.ts';
import {Problem} from './types.ts';
import {validPath} from './git.ts';
export const containsPath=(prefix:string,path:string)=>path===prefix||path.startsWith(prefix+'/');
export const canPath=(principal:Principal,path:string)=>!principal.paths||principal.paths.some(prefix=>containsPath(prefix,path));
export function authorizePaths(principal:Principal,paths:string[]){if(paths.some(path=>!canPath(principal,path)))throw new Problem(403,'path_scope','This credential cannot access that path');}
export function parseScopes(value:unknown):string[]|null{
 if(value===undefined||value===null)return null;
 if(!Array.isArray(value)||!value.length||value.length>16)throw new Problem(400,'path_scope','Choose 1–16 directory or file prefixes');value.forEach(validPath);return [...new Set(value)];
}
export type ReviewRule={prefix:string;independentReview:boolean;requireEvidence:boolean};
export function parseRules(value:unknown):ReviewRule[]{
 if(!Array.isArray(value)||value.length>32)throw new Problem(400,'review_policy','At most 32 path review rules');
 return value.map(rule=>{validPath(rule?.prefix);if(typeof rule.independentReview!=='boolean'||typeof rule.requireEvidence!=='boolean')throw new Problem(400,'review_policy','Set independentReview and requireEvidence explicitly');return {prefix:rule.prefix,independentReview:rule.independentReview,requireEvidence:rule.requireEvidence};});
}
export async function enforceReviewPolicy(db:any,project:string,rows:any[],reviewer?:string){
 const [policy]=await db`SELECT rules,updated_at FROM weave_review_policy WHERE project=${project}`;if(!policy)return;
 for(const row of rows){const rules=(policy.rules as ReviewRule[]).filter(rule=>row.files.some((file:any)=>containsPath(rule.prefix,file.path)));if(!rules.length)continue;
  if(!reviewer&&new Date(row.reviewed_at??0).getTime()<new Date(policy.updated_at).getTime())throw new Problem(409,'policy_changed','Review policy changed; approve this version again');
  if(rules.some(rule=>rule.independentReview)&&row.author===(reviewer??row.reviewer))throw new Problem(403,'independent_review','This path requires approval by a different principal');
  if(rules.some(rule=>rule.requireEvidence)&&!(Array.isArray(row.context?.evidence)&&row.context.evidence.some((e:any)=>typeof e.command==='string'&&e.command.trim()&&e.result==='pass')))throw new Problem(409,'review_evidence','This path requires recorded passing evidence before approval');
 }
}

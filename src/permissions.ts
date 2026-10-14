import {verifySemantic,type SemanticRule} from './semantic.ts';
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
export type ReviewRule={prefix:string;independentReview:boolean;requireEvidence:boolean;semantic?:SemanticRule};
export function parseRules(value:unknown):ReviewRule[]{
 if(!Array.isArray(value)||value.length>32)throw new Problem(400,'review_policy','At most 32 path review rules');
 return value.map(rule=>{validPath(rule?.prefix);if(typeof rule.independentReview!=='boolean'||typeof rule.requireEvidence!=='boolean')throw new Problem(400,'review_policy','Set independentReview and requireEvidence explicitly');if(rule.semantic!==undefined&&!['javascript-comments','json-values'].includes(rule.semantic))throw new Problem(400,'review_policy','Unsupported semantic constraint');return {prefix:rule.prefix,independentReview:rule.independentReview,requireEvidence:rule.requireEvidence,...(rule.semantic?{semantic:rule.semantic}:{})};});
}
export async function enforceReviewPolicy(db:any,project:string,rows:any[],reviewer?:string,blob?:(oid:string)=>Promise<Uint8Array>){
 const [policy]=await db`SELECT rules,updated_at FROM weave_review_policy WHERE project=${project}`;if(!policy)return;
 for(const row of rows){const rules=(policy.rules as ReviewRule[]).filter(rule=>row.files.some((file:any)=>containsPath(rule.prefix,file.path)));if(!rules.length)continue;
  let bytes=0;for(const file of row.files){const selected=rules.filter(rule=>rule.semantic&&containsPath(rule.prefix,file.path));if(!selected.length)continue;if(!file.before||!file.after||file.mode!==file.beforeMode||!blob)throw new Problem(409,'semantic_constraint','Semantic constraints require an existing file with unchanged permissions');const [before,after]=await Promise.all([blob(file.before),blob(file.after)]);bytes+=before.length+after.length;if(bytes>2*1024*1024)throw new Problem(413,'semantic_budget','Semantic review exceeds 2 MiB per change');for(const rule of selected)verifySemantic(rule.semantic!,file.path,before,after);}
  if(!reviewer&&new Date(row.reviewed_at??0).getTime()<new Date(policy.updated_at).getTime())throw new Problem(409,'policy_changed','Review policy changed; approve this version again');
  if(rules.some(rule=>rule.independentReview)&&row.author===(reviewer??row.reviewer))throw new Problem(403,'independent_review','This path requires approval by a different principal');
  if(rules.some(rule=>rule.requireEvidence)&&!(Array.isArray(row.context?.evidence)&&row.context.evidence.some((e:any)=>typeof e.command==='string'&&e.command.trim()&&e.result==='pass')))throw new Problem(409,'review_evidence','This path requires recorded passing evidence before approval');
 }
}

/** Read immutable content before entering the review/publication transaction. */
export async function prepareReviewContent(db:any,project:string,rows:any[],read:(oid:string)=>Promise<Uint8Array>){
 const [policy]=await db`SELECT rules FROM weave_review_policy WHERE project=${project}`;const rules=(policy?.rules??[]).filter((rule:ReviewRule)=>rule.semantic),values=new Map<string,Uint8Array>();
 for(const row of rows){let bytes=0;for(const file of row.files){if(!rules.some((rule:ReviewRule)=>containsPath(rule.prefix,file.path)))continue;for(const oid of [file.before,file.after])if(oid){if(!values.has(oid))values.set(oid,await read(oid));bytes+=values.get(oid)!.length;if(bytes>2*1024*1024)throw new Problem(413,'semantic_budget','Semantic review exceeds 2 MiB per change');}}}
 return async(oid:string)=>{const value=values.get(oid);if(!value)throw new Problem(409,'policy_changed','Semantic policy changed while preparing content; review this version again');return value;};
}

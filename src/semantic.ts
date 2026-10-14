import {parse} from 'acorn';
import {Problem} from './types.ts';
export type SemanticRule='javascript-comments'|'json-values';
const failure=(message:string)=>new Problem(409,'semantic_constraint',message);
function jsonValue(source:string){
 let value;try{value=JSON.parse(source);}catch{throw failure('JSON constraint requires valid JSON on both sides');}
 // JSON.parse accepts repeated keys. Reject that ambiguity before comparing values.
 const stack:(Set<string>|null)[]=[];
 for(const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)){
  const token=match[0];if(token==='{')stack.push(new Set());else if(token==='[')stack.push(null);else if(token==='}'||token===']')stack.pop();else if(/^\s*:/.test(source.slice(match.index!+token.length))){const key=JSON.parse(token),keys=stack.at(-1);if(!keys||keys.has(key))throw failure('JSON constraint rejects duplicate keys');keys.add(key);}
 }
 function normalized(v:any):any{if(v===null||typeof v!=='object'){if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw failure('JSON numbers must be finite and integers must be exactly representable');return v;}return Array.isArray(v)?v.map(normalized):Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalized(v[k])]));}
 return JSON.stringify(normalized(value));
}
function javascript(source:string){
 const comments:any[]=[];let ast:any;
 try{ast=parse(source,{ecmaVersion:'latest',sourceType:'module',onComment:comments});}catch{throw failure('JavaScript constraint requires supported, valid ECMAScript on both sides');}
 const directives=comments.filter(c=>/[@#!]|sourceURL|sourceMappingURL|eslint|jshint|istanbul|\bc8\b|webpack|vite|rollup|prettier|\bglobal\b|\bexported\b/i.test(c.value)).map(c=>[c.type,c.value]);
 function normalized(v:any):any{if(typeof v==='bigint')return {bigint:String(v)};if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(normalized);return Object.fromEntries(Object.keys(v).filter(k=>!['start','end','loc'].includes(k)&&!(k==='raw'&&v.type==='Literal')).sort().map(k=>[k,normalized(v[k])]));}
 return {ast:JSON.stringify(normalized(ast)),directives:JSON.stringify(directives),hashbang:source.startsWith('#!')?source.split('\n')[0]:null};
}
export function verifySemantic(rule:SemanticRule,path:string,before:Uint8Array,after:Uint8Array){
 if(before.length>256*1024||after.length>256*1024)throw failure('Semantic review accepts at most 256 KiB per file');let a:string,b:string;
 try{const decoder=new TextDecoder('utf-8',{fatal:true});a=decoder.decode(before);b=decoder.decode(after);}catch{throw failure('Semantic review requires UTF-8 source');}
 if(rule==='json-values'){if(!path.endsWith('.json')||jsonValue(a)!==jsonValue(b))throw failure('This path must preserve its JSON values');return;}
 if(!/\.(?:js|mjs|cjs)$/.test(path))throw failure('Comment constraints support JavaScript files only');
 const left=javascript(a),right=javascript(b);if(left.ast!==right.ast||left.directives!==right.directives||left.hashbang!==right.hashbang)throw failure('This path permits comments and formatting only; syntax and tool directives must remain unchanged');
}

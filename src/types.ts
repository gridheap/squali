import type postgres from 'postgres';
export type Sql = ReturnType<typeof postgres>;
export type TreeEntry = {name:string;mode:string;type:'tree'|'blob'|'commit';oid:string};
export type Commit = {oid:string;tree:string;parents:string[];message:string};
export interface Repository {
  info():Promise<{name:string;remote:string}>;
  head(ref?:string):Promise<string|null>;
  commit(oid:string):Promise<Commit|null>;
  tree(oid:string):Promise<TreeEntry[]>;
  blob(oid:string):Promise<Uint8Array>;
  git(request:Request,suffix:string):Promise<Response>;
  push(ref:string,old:string|null,oid:string,pack:Uint8Array):Promise<void>;
}
export interface Artifacts {
  create(name:string):Promise<void>;
  repo(name:string):Repository;
}
export type Principal={id:string;role:'admin'|'reviewer'|'agent'|'reader';projects:string[]};
export type Patch={path:string;content:string|null;mode?:'100644'|'100755'};
export type Config={sql:Sql;artifacts:Artifacts;principals:Record<string,Principal>;mode:string;maxProjects:number;monthlyOps:number;assets?:(request:Request)=>Promise<Response>;adobeKit?:string};
export class Problem extends Error {
 constructor(public status:number,public code:string, message:string,public details?:unknown){super(message);}
}
export const ZERO='0'.repeat(40);

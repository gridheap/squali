import type postgres from 'postgres';
export type Sql = ReturnType<typeof postgres>;
export type TreeEntry = {name:string;mode:string;rawMode?:string;type:'tree'|'blob'|'commit';oid:string};
export type Commit = {oid:string;tree:string;parents:string[];message:string};
export type RawObject={oid:string;type:'commit'|'tree'|'blob'|'tag';data:Uint8Array};
export type SourceDelta={path:string;mode:string|null;gitOid:string|null;rawMode?:string};
export interface Repository {
  writeLease?():Promise<{remote:string;token:string}>;
  persist?(oid:string,objects:RawObject[],delta?:SourceDelta[]):Promise<boolean>;
  info():Promise<{name:string;remote:string}>;
  head(ref?:string):Promise<string|null>;
  commit(oid:string):Promise<Commit|null>;
  tree(oid:string):Promise<TreeEntry[]>;
  blob(oid:string):Promise<Uint8Array>;
  git(request:Request,suffix:string):Promise<Response>;
  receive(refs:import('./git-transfer.ts').GitRef[],pack:ReadableStream<Uint8Array>):Promise<void>;
  push(ref:string,old:string|null,oid:string,pack:Uint8Array):Promise<void>;
}
export interface Artifacts {
  create(name:string,defaultBranch?:string):Promise<void>;
  repo(name:string):Repository;
}
export type Principal={id:string;role:'admin'|'reviewer'|'agent'|'reader';projects:string[];owner?:string;paths?:string[];expiresAt?:number};
export type Patch={path:string;content:string|null;mode?:'100644'|'100755'};
export type Config={databaseReady?:()=>Promise<void>;nativeImports?:boolean;source?:import('./source-store.ts').SourceStore;sql:Sql;artifacts:Artifacts;principals:Record<string,Principal>;mode:string;maxProjects:number;monthlyOps:number;cacheBudget?:{reads:number;writes:number};assets?:(request:Request)=>Promise<Response>;adobeKit?:string;clerk?:{publishableKey:string;secretKey:string;jwtKey?:string;appOrigin?:string;apiOrigin?:string};github?:{apiOrigin:string;gitOrigin:string}};
export class Problem extends Error {
 constructor(public status:number,public code:string, message:string,public details?:unknown){super(message);}
}
export const ZERO='0'.repeat(40);

import {verifyToken} from '@clerk/backend';
import {sha256} from './git.ts';
import {Problem} from './types.ts';
import type {Config,Principal} from './types.ts';
export function clerkDomain(key:string){
 const domain=Buffer.from(key.replace(/^pk_(live|test)_/,''),'base64').toString().replace(/\$$/,'');
 if(!/^[a-zA-Z0-9.-]+$/.test(domain)||!domain.includes('.'))throw new Error('Invalid Clerk publishable key');return domain;
}
export async function authenticate(request:Request,config:Config):Promise<Principal>{
 const token=request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
 const machine=config.principals[sha256(token)];if(machine)return machine;
 if(token.startsWith('sq_')){const [row]=await config.sql`SELECT id,project,role,paths FROM weave_tokens WHERE token_hash=${sha256(token)} AND expires_at>now() AND revoked_at IS NULL`;if(row)return {id:'agent:'+row.id,role:row.role,projects:[row.project],...(row.paths?{paths:row.paths}:{})};}
 if(config.clerk&&token){
  try{
   const claims=await verifyToken(token,{secretKey:config.clerk.secretKey,jwtKey:config.clerk.jwtKey,authorizedParties:[config.clerk.appOrigin??new URL(request.url).origin]});
   if(claims.iss!=='https://'+clerkDomain(config.clerk.publishableKey)||!claims.sub||!claims.sid)throw new Error('Invalid identity');
   const owner='clerk:'+claims.sub;
   const rows=await config.sql`SELECT id FROM weave_projects WHERE owner_id=${owner}`;
   return {id:owner,owner,role:'admin',projects:rows.map(r=>r.id)};
  }catch{throw new Problem(401,'unauthorized','Sign in again with GitHub to continue');}
 }
 throw new Problem(401,'unauthorized','Connect with a valid access token or sign in with GitHub');
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {startLocal} from '../scripts/local.ts';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
// Workers only supports follow/manual. Exercise its fetch contract at the HTTP boundary.
const nativeFetch=globalThis.fetch;
globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{if(init?.redirect==='error')throw new TypeError('Workers does not support redirect:error');return nativeFetch(input,init);}) as typeof fetch;
const domain='squali-fixture.clerk.accounts.dev';
const clerk={publishableKey:'pk_test_'+Buffer.from(domain+'$').toString('base64'),secretKey:'sk_test_fixture',jwtKey:publicKey.export({type:'spki',format:'pem'}).toString()};
export function session(user:string,origin:string,extra:Record<string,unknown>={}){const now=Math.floor(Date.now()/1000);const encoded=[{alg:'RS256',typ:'JWT',kid:'fixture'},{iss:'https://'+domain,sub:user,sid:'sess_fixture',azp:origin,iat:now,nbf:now-5,exp:now+300,...extra}].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return encoded+'.'+sign('RSA-SHA256',Buffer.from(encoded),privateKey).toString('base64url');}

test('Clerk sessions create private owner workspaces and reject forged, expired and foreign sessions',async()=>{
 const server=await startLocal({port:0,test:true,clerk});
 try{
  const call=async(path:string,user='user_alice',data?:unknown,extra:Record<string,unknown>={})=>{const res=await fetch(server.url+'/api'+path,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+session(user,server.url,extra),'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,body:await res.json() as any};};
  assert.equal((await call('/session')).status,200);
  assert.equal((await call('/session','user_alice',undefined,{exp:1})).status,401);
  assert.equal((await call('/session','user_alice',undefined,{iss:'https://foreign.clerk.accounts.dev'})).status,401);
  assert.equal((await call('/session','user_alice',undefined,{azp:'https://evil.invalid'})).status,401);
  assert.equal((await fetch(server.url+'/api/session',{headers:{authorization:'Bearer '+session('user_alice',server.url).slice(0,-6)+'forged'}})).status,401);
  const made=await call('/projects','user_alice',{id:'alice-work',name:'Alice private',files:[{path:'README.md',content:'Private\n'}]});assert.equal(made.status,201,JSON.stringify(made.body));
  assert.equal((await call('/projects')).body.projects.length,1);
  assert.deepEqual((await call('/projects','user_bob')).body.projects,[]);
  assert.equal((await call('/projects/alice-work','user_bob')).status,403);
  assert.equal((await call('/projects','user_bob',{id:'alice-work',name:'Alice private',files:[{path:'README.md',content:'Private\n'}]})).status,403);
  assert.equal((await call('/projects/alice-work')).status,200);
  const machine=async(token:string,path:string,data?:unknown)=>{const r=await fetch(server.url+'/api'+path,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json() as any};};
  assert.equal((await machine('local-agent-test-token','/projects/alice-work')).status,403,'Legacy wildcard tokens must not gain access to new personal workspaces');
  assert.deepEqual((await machine('local-admin-test-token','/projects')).body.projects,[]);
  const credential=await call('/projects/alice-work/tokens','user_alice',{label:'Coding agent',role:'agent',days:7});assert.equal(credential.status,201,JSON.stringify(credential.body));assert.ok(credential.body.token);
  assert.equal((await call('/projects/alice-work/tokens','user_bob',{label:'Steal',role:'agent',days:7})).status,403);
  const proposed=await machine(credential.body.token,'/projects/alice-work/changes',{id:'machine-change',title:'Agent proposal',intent:'Use a scoped automation credential',files:[{path:'agent.txt',content:'scoped\n'}]});assert.equal(proposed.status,201,JSON.stringify(proposed.body));
  assert.equal((await machine(credential.body.token,'/projects/alice-work/changes/machine-change/review',{decision:'approved'})).status,403);
  assert.equal((await machine(credential.body.token,'/github/imports')).status,403);
  const listed=await call('/projects/alice-work/tokens');assert.equal(listed.status,200);assert.equal(JSON.stringify(listed.body).includes(credential.body.token),false);
  await call('/projects/alice-work/tokens/'+credential.body.id+'/revoke','user_alice',{});assert.equal((await machine(credential.body.token,'/projects/alice-work')).status,401);
  console.log('HTTP Clerk identity: owner isolation, expiry, signature, issuer and authorized party verified.');
 }finally{await server.close();}
});

test('GitHub catalog and resumable import preserve private Git history, branches and tags without duplicate transfer',async()=>{
 const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);const {writeFile}=await import('node:fs/promises');
 const source=await startLocal({port:0,test:true});let transferCount=0;let catalogCount=0;let revokedSecond=false;let repositoryScope=true;let redirectToken=false;let redirectHits=0;
 const create=async(id:string)=>fetch(source.url+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id,name:id,files:[{path:'README.md',content:'Private source\n'}]})}).then(r=>r.json()) as Promise<any>;
 const upstream=await create('origin');const empty=await create('empty-source');await exec('git',['init','--bare','--initial-branch=main',source.dir+'/truly-empty.git']);const emptyRemote=empty.remote.replace('weave-empty-source.git','truly-empty.git');
 const checkout=source.dir+'/checkout';await exec('git',['clone',upstream.remote,checkout]);await exec('git',['-C',checkout,'checkout','-b','trunk']);await writeFile(checkout+'/second.txt','second commit\n');await exec('git',['-C',checkout,'add','.']);await exec('git',['-C',checkout,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Second source commit']);await exec('git',['-C',checkout,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','tag','-a','v1','-m','Annotated release']);await exec('git',['-C',checkout,'push','origin','trunk','refs/tags/v1']);const head=(await exec('git',['-C',checkout,'rev-parse','HEAD'])).stdout.trim();
 const records=[{id:101,full_name:'owner/private',private:true,default_branch:'trunk',size:322175,archived:false,permissions:{pull:true}},{id:102,full_name:'owner/second',private:false,default_branch:'main',size:1,archived:false,permissions:{pull:true}},{id:103,full_name:'owner/empty',private:true,default_branch:'main',size:0,archived:false,permissions:{pull:true}}];
 const provider=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://fixture');
  if(url.pathname==='/credential-sink'){redirectHits++;res.writeHead(500).end();return;}
  if(url.pathname.includes('/oauth_access_tokens/')&&redirectToken){res.writeHead(302,{location:providerUrl+'/credential-sink'}).end();return;}
  if(url.pathname.includes('/oauth_access_tokens/')){res.setHeader('content-type','application/json');res.end(JSON.stringify([{token:'github-fixture-only',scopes:repositoryScope?['repo','read:user','user:email']:['read:user','user:email'],provider:'oauth_github'}]));return;}
  if(req.headers.authorization!=='Bearer github-fixture-only'&&!req.headers.authorization?.startsWith('Basic ')){res.writeHead(401).end();return;}
  if(url.pathname==='/user/repos'){catalogCount++;const page=Number(url.searchParams.get('page')??1);if(page===1)res.setHeader('Link','<http://fixture/user/repos?page=2>; rel="next"');res.setHeader('content-type','application/json');res.end(JSON.stringify(page===1?[records[0]]:records.slice(1)));return;}
  if(url.pathname==='/repositories/102'&&revokedSecond){res.writeHead(404).end();return;}
  if(url.pathname.startsWith('/repositories/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(records.find(r=>String(r.id)===url.pathname.split('/').at(-1))));return;}
  if(url.pathname.startsWith('/git/owner/')){const remote=url.pathname.includes('/private.git')?upstream.remote:url.pathname.includes('/empty.git')?emptyRemote:empty.remote;const suffix=url.pathname.replace(/^\/git\/owner\/[^/]+/,'')+url.search;const chunks=[];for await(const chunk of req)chunks.push(chunk);if(req.method==='POST')transferCount++;const r=await fetch(remote+suffix,{method:req.method,headers:{'content-type':req.headers['content-type']??''},body:req.method==='POST'?Buffer.concat(chunks):undefined});res.writeHead(r.status,{'content-type':r.headers.get('content-type')??''});res.end(Buffer.from(await r.arrayBuffer()));return;}
  res.writeHead(404).end();
 });await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const providerUrl='http://127.0.0.1:'+(provider.address() as any).port;
 const server=await startLocal({port:0,test:true,failImportCreateOnce:true,clerk:{...clerk,apiOrigin:providerUrl},github:{apiOrigin:providerUrl,gitOrigin:providerUrl+'/git'}});
 try{
  const call=async(path:string,data?:unknown,user='user_alice')=>{const r=await fetch(server.url+'/api'+path,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+session(user,server.url),'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json() as any};};
  repositoryScope=false;
  assert.equal((await call('/session')).status,200,'Identity-only sign-in remains usable');
  const unconnected=await call('/github/repositories');assert.equal(unconnected.status,403);assert.equal(unconnected.body.error,'github_scope');assert.equal(catalogCount,0,'No repository discovery before consent');
  repositoryScope=true;redirectToken=true;
  assert.equal((await call('/github/repositories')).status,403);assert.equal(redirectHits,0,'Credentials cannot follow provider redirects');
  redirectToken=false;
  const first=await call('/github/repositories');assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.repositories[0].private,true);assert.equal(first.body.nextPage,2);
  await call('/github/repositories');assert.equal(catalogCount,1,'Fresh catalog is reused');
  const second=await call('/github/repositories?page=2');assert.equal(second.body.nextPage,null);
  const queued=await call('/github/imports',{repositoryIds:[101,101,102]});assert.equal(queued.status,201,JSON.stringify(queued.body));assert.equal(queued.body.imports.length,2);
  const item=queued.body.imports.find((r:any)=>r.repositoryId===101);
  const checked=await call('/github/imports/'+item.id+'/reconcile',{});assert.equal(checked.status,409);assert.equal(transferCount,0,'Reconciliation never starts a transfer');assert.equal((await call('/github/imports')).body.imports.find((r:any)=>r.id===item.id).state,'queued');assert.equal((await call('/github/imports')).body.imports.find((r:any)=>r.id===item.id).attempts,0);
  assert.equal((await call('/github/imports/'+item.id+'/run',{},'user_bob')).status,404);
  assert.equal((await call('/github/imports/'+item.id+'/run',{})).status,502);
  const result=await call('/github/imports/'+item.id+'/run',{});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.state,'complete');assert.equal(result.body.head,head);
  assert.equal((await call('/github/imports/'+item.id+'/reconcile',{})).body.state,'complete');
  const repeated=await call('/github/imports/'+item.id+'/run',{});assert.equal(repeated.body.head,head);assert.equal(transferCount,1,'Retry must not download a successful pack');
  assert.equal((await call('/github/imports',{repositoryIds:[101]})).body.imports[0].id,item.id);
  const projectId=result.body.projectId;const projects=(await call('/projects')).body.projects;assert.equal(projects[0].head,head);
  const clone=server.dir+'/imported';await exec('git',['-c','http.extraHeader=Authorization: Bearer '+session('user_alice',server.url),'clone',server.url+'/api/projects/'+projectId+'/git',clone]);await exec('git',['-C',clone,'fsck','--full']);assert.equal((await exec('git',['-C',clone,'rev-parse','HEAD'])).stdout.trim(),head);assert.equal((await exec('git',['-C',clone,'log','--format=%s'])).stdout.trim(),'Second source commit\nInitialize origin');assert.equal((await exec('git',['-C',clone,'cat-file','-t','v1'])).stdout.trim(),'tag');assert.equal((await exec('git',['-C',clone,'rev-parse','origin/main'])).stdout.trim(),upstream.head);
  const proposal=await call('/projects/'+projectId+'/changes',{id:'import-edit',title:'Edit imported source',intent:'Use imported default branch',files:[{path:'second.txt',content:'reviewed\n'}]});assert.equal(proposal.status,201);assert.equal(proposal.body.base,head);
  await call('/projects/'+projectId+'/changes/import-edit/review',{decision:'approved'});assert.equal((await call('/projects/'+projectId+'/publish',{id:'import-publish',changes:['import-edit']})).status,201);
  assert.equal((await call('/projects/'+projectId,undefined,'user_bob')).status,403);
  assert.equal((await call('/github/imports')).body.imports.find((r:any)=>r.id===item.id).state,'complete');
  const {chromium}=await import('@playwright/test');const {mkdir}=await import('node:fs/promises');
  const browser=await chromium.launch({executablePath:'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(10000);
  try{
   const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://use.typekit.net/**',async route=>{await new Promise(r=>setTimeout(r,3500));await route.abort();});
   await page.route('https://'+domain+'/**',route=>route.fulfill({contentType:'application/javascript',body:`const listeners=[];const granted=location.search.includes('scope=repo');const account={provider:'github',approvedScopes:granted?'read:user user:email repo':'read:user user:email',reauthorize:async p=>{if(p.additionalScopes.join()!=='repo'||p.redirectUrl!==location.origin+'/?view=github')throw Error('Wrong scope or callback');return {verification:{externalVerificationRedirectURL:{href:location.origin+'/?view=github&scope=repo'}}};}};const fixtureUser={id:'user_alice',externalAccounts:[account]};const fixtureSession={getToken:async()=>${JSON.stringify(session('user_alice',server.url))}};window.Clerk={user:granted?fixtureUser:null,session:granted?fixtureSession:null,load:async()=>{},addListener:f=>listeners.push(f),redirectToSignIn:async()=>{window.Clerk.user=fixtureUser;window.Clerk.session={getToken:async()=>${JSON.stringify(session('user_alice',server.url))}};for(const f of listeners)f({user:window.Clerk.user,session:window.Clerk.session});},signOut:async()=>{window.Clerk.user=null;window.Clerk.session=null;for(const f of listeners)f({user:null,session:null});}};` }));
   const uiStarted=Date.now();await page.goto(server.url,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Continue with GitHub',exact:true}).waitFor();const signInReadyMs=Date.now()-uiStarted;const pendingFont=await page.locator('html').getAttribute('class');assert.match(pendingFont??'',/wf-loading/);
   await page.getByRole('button',{name:'Continue with GitHub',exact:true}).click();await page.getByText('Signed in with GitHub',{exact:true}).waitFor();assert.match((await page.locator('html').getAttribute('class'))??'',/wf-loading/);
   await mkdir('work/github-evidence',{recursive:true});await writeFile('work/github-evidence/runtime.json',JSON.stringify({command:'pnpm test:github',provider:'local HTTP + real Git, Clerk frontend SDK boundary fixture',signInReadyMs,signedInMs:Date.now()-uiStarted,fontPendingAtSignIn:true},null,2));
   await page.getByRole('button',{name:'GitHub repositories',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Import all repositories',exact:true}).count(),0,'Login alone must not start repository discovery');
   await page.getByRole('button',{name:'Grant repository access',exact:true}).click();
   await page.getByRole('button',{name:'Import all repositories',exact:true}).waitFor();
   revokedSecond=true;await page.getByRole('button',{name:'Import all repositories',exact:true}).click();await page.getByText('2 repositories imported. 1 pending. Progress is saved.',{exact:true}).waitFor();
   revokedSecond=false;await page.getByRole('button',{name:'Resume pending imports',exact:true}).click();await page.getByText('3 repositories imported. No pending imports.',{exact:true}).waitFor();
   assert.equal(transferCount,2,'Import all reuses the first import and transfers only the second');
   await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await mkdir('work/github-evidence',{recursive:true});await page.screenshot({path:'work/github-evidence/import-mobile.png',fullPage:true});
   await page.getByRole('button',{name:'Agent access',exact:true}).click();await page.getByLabel('Credential label',{exact:true}).fill('Browser agent');await page.getByLabel('Allowed paths',{exact:true}).fill('docs');await page.getByRole('button',{name:'Create agent token',exact:true}).click();
   const scoped=await page.getByLabel('Agent token',{exact:true}).inputValue();assert.match(scoped,/^sq_/);await page.getByRole('button',{name:'Close details',exact:true}).click();
   await page.getByRole('button',{name:'Sign out',exact:true}).click();assert.equal(await page.getByText('owner/private',{exact:true}).count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
  const blank=(await call('/github/imports')).body.imports.find((r:any)=>r.repositoryId===103);assert.equal(blank.state,'complete');assert.equal(blank.head,null);
  assert.deepEqual((await call('/projects/'+blank.projectId+'/tree')).body.entries,[]);
  const initial=await call('/projects/'+blank.projectId+'/changes',{id:'first',title:'First commit',intent:'Start an empty repository through review',files:[{path:'README.md',content:'From empty\n'}]});assert.equal(initial.status,201,JSON.stringify(initial.body));
  await call('/projects/'+blank.projectId+'/changes/first/review',{decision:'approved'});const initialPublished=await call('/projects/'+blank.projectId+'/publish',{id:'initial',changes:['first']});assert.equal(initialPublished.status,201,JSON.stringify(initialPublished.body));
  assert.equal((await call('/projects/'+blank.projectId+'/file?path=README.md')).body.content,'From empty\n');
  const {fork}=await import('node:child_process');const {once}=await import('node:events');
  const startChild=async(dir?:string)=>{
   const child=fork('tests/fixtures/import-crash-server.ts',[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','inherit','ipc'],env:{...process.env,SQUALI_FIXTURE_CONFIG:JSON.stringify({clerk:{...clerk,apiOrigin:providerUrl},github:{apiOrigin:providerUrl,gitOrigin:providerUrl+'/git'}}),SQUALI_FIXTURE_DIR:dir,SQUALI_PAUSE_IMPORT:dir?'0':'1'}});
   const ready=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Import child startup timed out')),10000);child.on('message',(m:any)=>{if(m.type==='ready'){clearTimeout(timer);resolve(m);}});child.once('error',reject);});return {child,...ready};
  };
  let child=await startChild();const childCall=async(path:string,data?:unknown)=>{const r=await fetch(child.url+'/api'+path,{signal:AbortSignal.timeout(5000),method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+session('user_alice',child.url),'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json() as any};};
  try{
   await childCall('/github/repositories');await childCall('/github/repositories?page=2');const crashJobs=(await childCall('/github/imports',{repositoryIds:[101,102]})).body.imports;const crashJob=crashJobs.find((r:any)=>r.repositoryId===101);const otherJob=crashJobs.find((r:any)=>r.repositoryId===102);
   const pushed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Import push did not arrive')),10000);child.child.on('message',(m:any)=>{if(m.type==='pushed'){clearTimeout(timer);resolve();}});});
   const interrupted=childCall('/github/imports/'+crashJob.id+'/run',{}).catch(()=>null);await pushed;assert.equal((await childCall('/github/imports/'+otherJob.id+'/run',{})).status,409,'A deployment admits one import to preserve database connection capacity');const exited=once(child.child,'exit');child.child.kill('SIGKILL');await exited;await interrupted;
   const transfers=transferCount;child=await startChild(child.dir);const recovered=await childCall('/github/imports/'+crashJob.id+'/run',{});assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.head,head);assert.equal(recovered.body.state,'complete');assert.equal(transferCount,transfers,'SIGKILL recovery must not repeat an accepted pack transfer');
   console.log('Import SIGKILL: native Git accepted the atomic pack; restart reconciled all frozen refs; zero duplicate transfers.');
  }finally{const done=once(child.child,'exit');child.child.kill('SIGKILL');await done;}
  console.log('GitHub E2E: paginated catalog cached; private full history + two branches + annotated tag; default trunk; native clone/fsck; proposal/review/publication; replay avoided duplicate transfer.');
 }finally{await server.close();await source.close();await new Promise<void>(r=>provider.close(()=>r()));}
});

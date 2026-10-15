#!/usr/bin/env python3
"""Bounded native Git -> Squali source ingestion. Reuse --state after interruption."""
import argparse,fcntl,base64,gzip,hashlib,json,os,pathlib,re,subprocess,sys,time,http.client,urllib.parse
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('project');p.add_argument('repository');p.add_argument('--state',required=True)
p.add_argument('--max-objects',type=int,default=500000);p.add_argument('--max-bytes',type=int,default=16*1024**3)
p.add_argument('--git-export-max-bytes',type=int,default=1000000000)
p.add_argument('--max-requests',type=int,default=12000);p.add_argument('--max-batches',type=int,default=128);p.add_argument('--max-seconds',type=int,default=900)
a=p.parse_args();base=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN')
if not token:raise SystemExit('Set SQUALI_TOKEN in the environment')
if not 1<=a.git_export_max_bytes<=1000000000 or not 1<=a.max_objects<=2000000 or not 1<=a.max_bytes<=100*1024**3 or not 1<=a.max_requests<=30000 or not 1<=a.max_batches<=10000 or not 1<=a.max_seconds<=7200:raise SystemExit('Invalid finite ingestion budgets')
root=pathlib.Path(a.state);root.mkdir(mode=0o700,parents=True,exist_ok=True);journal=root/'state.json'
lock_file=open(root/'import.lock','a+');os.chmod(root/'import.lock',0o600)
try:fcntl.flock(lock_file,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('An importer is already running for this state')
started=time.monotonic();batches=0

def git(*args,stdout=subprocess.PIPE,stdin=None):
 r=subprocess.run(['git','-C',a.repository,*args],stdin=stdin,stdout=stdout,stderr=subprocess.PIPE,timeout=180)
 if r.returncode:raise RuntimeError('Native Git preparation failed')
 return r.stdout.decode().strip() if r.stdout is not None else None
refs=[dict(zip(('name','oid'),line.split(' '))) for line in git('for-each-ref','--format=%(refname) %(objectname)','refs/heads','refs/tags').splitlines()]
if len(refs)>5000:raise SystemExit('Ref budget exceeded')
branch=git('symbolic-ref','--short','HEAD')
identity={'origin':base,'project':a.project,'repository':str(pathlib.Path(a.repository).resolve()),'refs':refs,'branch':branch,'maxObjects':a.max_objects,'maxBytes':a.max_bytes,'maxRequests':a.max_requests}
if a.git_export_max_bytes!=1000000000:identity['gitExportMaxBytes']=a.git_export_max_bytes
fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
state=json.loads(journal.read_text()) if journal.exists() else {'fingerprint':fingerprint,'identity':identity,'stage':'objects','objectsProcessed':0,'commitsProcessed':0,'httpAttempts':0,'uploadedBytes':0,'complete':False}
if state['fingerprint']!=fingerprint:raise SystemExit('Source refs, destination or total budgets changed; retain this state and investigate')

def save():
 temp=journal.with_suffix('.tmp');data=json.dumps(state,indent=2)+'\n'
 with open(temp,'w') as f:os.chmod(temp,0o600);f.write(data);f.flush();os.fsync(f.fileno())
 os.replace(temp,journal)

def report(reused=False):
 print(json.dumps({k:state[k] for k in ('stage','objectsProcessed','commitsProcessed','httpAttempts','uploadedBytes','complete')}|{'reused':reused}))

if state['complete']:report(True);raise SystemExit(0)
if not (root/'objects.txt').exists():
 with open(root/'ids.txt','wb') as out:git('rev-list','--objects','--all','--no-object-names',stdout=out)
 with open(root/'ids.txt','rb') as source,open(root/'objects.tmp','wb') as out:git('cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)',stdin=source,stdout=out)
 count=0;size=0
 for line in (root/'objects.tmp').read_text().splitlines():
  oid,kind,n=line.split();count+=1;size+=int(n)
  if kind not in ('blob','tree','commit','tag') or int(n)>32*1024*1024:raise RuntimeError('Source contains an unsupported or oversized object')
 if count>a.max_objects or size>a.max_bytes:raise RuntimeError('Source exceeds the admitted total object/byte budget; no HTTP request was made')
 # Stable mixed-type order makes a bounded pilot representative of content and metadata.
 lines=(root/'objects.tmp').read_text().splitlines();lines.sort();(root/'objects.tmp').write_text('\n'.join(lines)+'\n')
 os.replace(root/'objects.tmp',root/'objects.txt')
 with open(root/'commits.txt','wb') as out:git('rev-list','--reverse','--topo-order','--all',stdout=out)
 state.update(sourceObjects=count,sourceBytes=size);save()

endpoint=urllib.parse.urlparse(base)
if endpoint.scheme not in ('https','http') or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:raise SystemExit('Invalid source endpoint')
http=(http.client.HTTPSConnection if endpoint.scheme=='https' else http.client.HTTPConnection)(endpoint.hostname,endpoint.port,timeout=60)
class SourceFailure(RuntimeError):
 def __init__(self,status,code):
  super().__init__('Source request failed: HTTP '+str(status)+' '+code);self.status=status;self.code=code
def call(suffix,body):
 if state['httpAttempts']>=a.max_requests:raise RuntimeError('Persistent HTTP attempt ceiling reached')
 state['httpAttempts']+=1;save();raw=body if isinstance(body,bytes) else json.dumps(body,separators=(',',':')).encode()
 path=endpoint.path+'/api/projects/'+urllib.parse.quote(a.project,safe='')+'/source/'+suffix
 # One connection per process. Disconnects and unknown acknowledgements stop the job;
 # reconnecting never silently retries a counted request and redirects are not followed.
 try:
  http.request('POST',path,body=raw,headers={'Authorization':'Bearer '+token,'User-Agent':'Squali-Native-Import/1','Content-Type':'application/gzip' if isinstance(body,bytes) else 'application/json'})
  response=http.getresponse();data=response.read(2*1024*1024+1)
 except Exception:
  http.close();raise
 if len(data)>2*1024*1024:http.close();raise RuntimeError('Source response exceeds 2 MiB')
 if not 200<=response.status<300:
  try:code=json.loads(data).get('error','unknown')
  except Exception:code='unknown'
  raise SourceFailure(response.status,code)
 return json.loads(data)

def exhausted():return batches>=a.max_batches or time.monotonic()-started>=a.max_seconds

def rows(path,skip,count=128):
 with open(path) as f:
  for _ in range(skip):
   if not f.readline():raise RuntimeError('Saved cursor exceeds the native manifest')
  while True:
   batch=[]
   for _ in range(count):
    line=f.readline()
    if not line:break
    batch.append(line.strip().split())
   if not batch:return
   yield batch

cat=None
try:
 if state['stage']=='objects':
  cat=subprocess.Popen(['git','-C',a.repository,'cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  for entries in rows(root/'objects.txt',state['objectsProcessed']):
   if exhausted():report();raise SystemExit(2)
   missing=set(call('missing',{'oids':[r[0] for r in entries]})['missing']);payload=[];compressed=0;expanded=0
   def upload():
    global payload,compressed,expanded
    if not payload:return
    call('objects',{'objects':payload});state['uploadedBytes']+=compressed;save();payload=[];compressed=0;expanded=0
   for expected,kind,length in entries:
    if expected not in missing:continue
    cat.stdin.write((expected+'\n').encode());cat.stdin.flush();header=cat.stdout.readline(256).decode().strip().split()
    if header!=[expected,kind,length]:raise RuntimeError('Native object header mismatch')
    data=cat.stdout.read(int(length));ending=cat.stdout.read(1)
    if len(data)!=int(length) or ending!=b'\n':raise RuntimeError('Truncated native object')
    encoded=gzip.compress(data,compresslevel=1,mtime=0)
    if len(encoded)>1024*1024:
     if kind!='blob':raise RuntimeError('Oversized metadata object')
     upload();call('blob/'+expected,encoded);state['uploadedBytes']+=len(encoded);save();continue
    if compressed+len(encoded)>1024*1024 or expanded+len(data)>64*1024*1024:upload()
    payload.append({'oid':expected,'type':kind,'encoding':'gzip','body':base64.b64encode(encoded).decode()});compressed+=len(encoded);expanded+=len(data)
   upload();state['objectsProcessed']+=len(entries);batches+=1;save()
  state['stage']='changesets';save()
 if state['stage']=='changesets':
  while True:
   reduced=False
   for entries in rows(root/'commits.txt',state['commitsProcessed'],state.get('sealBatchSize',128)):
    if exhausted():report();raise SystemExit(2)
    try:call('changesets',{'commits':[r[0] for r in entries]})
    except SourceFailure as error:
     if error.status!=413 or error.code!='source_seal_budget' or len(entries)==1:raise
     # Validation rejected this batch before any changeset was committed.
     # Persist the smaller admission size; all attempts share the same total ceiling.
     state['sealBatchSize']=max(1,len(entries)//2);save();reduced=True;break
    state['commitsProcessed']+=len(entries);batches+=1;save()
   if not reduced:break
  state['stage']='refs';save()
 if exhausted():report();raise SystemExit(2)
 lease=os.environ.get('SQUALI_JOB_LEASE')
 if lease and not state.get('bridgeComplete') and not state.get('bridgeLimited'):
  sizes=dict(line.split(': ',1) for line in git('count-objects','-v').splitlines())
  if (int(sizes.get('size-pack',0))+int(sizes.get('size',0)))*1024>a.git_export_max_bytes:
   state['bridgeLimited']={'limitBytes':a.git_export_max_bytes,'reason':'provider_limit'};save()
 if lease and not state.get('bridgeComplete') and not state.get('bridgeLimited'):
  if not state.get('bridgeConfirmed'):
   from git_seed import plan
   policy={'maxObjects':int(os.environ.get('SQUALI_GIT_SEED_OBJECT_CAP','16384')),'maxRawBytes':256*1024*1024,'maxPushes':128}
   seed_file=root/'seed-plan.json'
   if seed_file.exists():
    seed=json.loads(seed_file.read_text())
    if seed['refs']!=refs or seed['policy']!=policy or not seed.get('admissible'):raise RuntimeError('Frozen Git seed plan changed')
   else:
    seed=plan(a.repository,refs,root/'objects.txt',policy['maxObjects'],policy['maxRawBytes'],policy['maxPushes'])
    temporary=root/'seed-plan.tmp'
    with open(temporary,'w') as out:os.chmod(temporary,0o600);json.dump(seed,out);out.flush();os.fsync(out.fileno())
    os.replace(temporary,seed_file)
   if 'bridgePushAttempts' not in state:state['bridgePushAttempts']=state.get('bridgeAttempts',0);save()
   if not state.get('bridgeSeedStarted'):
    if state.get('bridgeAttempts',0)>=3:raise RuntimeError('Native Git seed attempt ceiling reached')
    state['bridgeAttempts']=state.get('bridgeAttempts',0)+1;state['bridgeSeedStarted']=True;save()
   offer=call('bridge-prepare',{'refs':refs,'defaultBranch':branch,'lease':lease});offer_used=False;acknowledged=set()
   for batch in seed['batches']:
    if offer['ready']:break
    if not isinstance(offer.get('pendingRefs'),list):raise RuntimeError('Deploy the bounded Git seed server before continuing')
    if not any(r['name'] in offer['pendingRefs'] for r in batch['refs']):
     acknowledged.update(r['name'] for r in batch['refs']);continue
    if exhausted():report();raise SystemExit(2)
    if offer_used:offer=call('bridge-prepare',{'refs':refs,'defaultBranch':branch,'lease':lease})
    if offer['ready']:break
    if any(name in offer['pendingRefs'] for name in acknowledged):raise RuntimeError('An earlier acknowledged seed ref disappeared; stop before another transfer')
    selected=[r for r in batch['refs'] if r['name'] in offer['pendingRefs']]
    if not selected:continue
    remote=urllib.parse.urlparse(offer['remote']);testing=os.environ.get('SQUALI_ALLOW_TEST_HTTP')=='1'
    if remote.username or remote.password or remote.query or remote.scheme not in (['http','https'] if testing else ['https']):raise RuntimeError('Unsafe native Git export destination')
    names=[r['name']+':'+r['name'] for r in selected]
    if sum(len(name) for name in names)>512*1024:raise RuntimeError('Native export ref arguments exceed 512 KiB')
    environment={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_ALLOW_PROTOCOL':'http:https','GIT_CONFIG_COUNT':'2','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+offer['token'],'GIT_CONFIG_KEY_1':'http.followRedirects','GIT_CONFIG_VALUE_1':'false','GIT_TRACE':'0','GIT_TRACE_CURL':'0','GIT_CURL_VERBOSE':'0'}
    for secret in ('SQUALI_TOKEN','SQUALI_WORKER_DATABASE_URL','GIT_CURL_VERBOSE','GIT_TRACE_CURL','GIT_TRACE_PACKET','GIT_TRACE_PACKFILE'):environment.pop(secret,None)
    if state.get('bridgePushAttempts',0)>=128:raise RuntimeError('Persistent native Git push ceiling reached')
    state['bridgePushAttempts']=state.get('bridgePushAttempts',0)+1;save()
    http.close() # The native Git push can exceed a provider's HTTP idle timeout.
    def bridge_error(code,stderr):
     detail=(stderr or b'').decode('utf-8',errors='replace')
     for credential in (offer['token'],token):
      if credential:detail=detail.replace(credential,'[redacted]')
     detail=re.sub(r'(?i)(authorization\s*:\s*)[^\r\n]*',r'\1[redacted]',detail)
     diagnostic={'operation':'native Git bootstrap','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'exitCode':code,'stderr':detail[-65536:]}
     temporary=root/'bridge-error.tmp'
     with open(temporary,'w') as out:os.chmod(temporary,0o600);json.dump(diagnostic,out);out.flush();os.fsync(out.fileno())
     os.replace(temporary,root/'bridge-error.json')
    # Bootstrap may accept a subset of frozen refs. prepare/confirm reconcile it;
    # the project stays importing until every ref matches. Artifacts has no atomic capability.
    try:exported=subprocess.run(['git','-C',a.repository,'-c','core.hooksPath=/dev/null','push',offer['remote'],*names],env=environment,capture_output=True,timeout=600)
    except subprocess.TimeoutExpired as error:
     bridge_error('timeout',error.stderr);raise RuntimeError('Native Git export timed out; resume reconciles provider refs before another transfer')
    if exported.returncode:
     bridge_error(exported.returncode,exported.stderr);raise RuntimeError('Native Git export stopped; resume reconciles provider refs before another transfer')
    state['bridgeSeedBatchesDone']=state.get('bridgeSeedBatchesDone',0)+1;save();offer_used=True;acknowledged.update(r['name'] for r in batch['refs'])
   confirmation=call('bridge-confirm',{'refs':refs,'defaultBranch':branch,'lease':lease});state['bridgeConfirmed']=True;state['bridgeManifest']=confirmation['manifest'];save();offer=None
  if not (root/'export-objects.txt').exists():
   with open(root/'export-roots.txt','w') as out:out.write('\n'.join(r['oid'] for r in refs)+'\n')
   with open(root/'export-roots.txt','rb') as source,open(root/'export-objects.tmp','wb') as out:git('rev-list','--objects','--no-object-names','--stdin',stdin=source,stdout=out)
   os.replace(root/'export-objects.tmp',root/'export-objects.txt')
  for entries in rows(root/'export-objects.txt',state.get('bridgeIndexed',0),2000):
   if exhausted():report();raise SystemExit(2)
   call('bridge-index',{'manifest':state['bridgeManifest'],'oids':[r[0] for r in entries],'lease':lease});state['bridgeIndexed']=state.get('bridgeIndexed',0)+len(entries);batches+=1;save()
  state['bridgeComplete']=True;save()
 call('finish',{'refs':refs,'defaultBranch':branch,'gitBridgeLimited':bool(state.get('bridgeLimited'))});state['stage']='complete';state['complete']=True;save();report()
except Exception as e:
 if state.get('bridgeSeedStarted'):state['bridgeSeedStarted']=False;save()
 print(str(e),file=sys.stderr);report();raise SystemExit(1)
finally:
 http.close()
 if cat:
  cat.stdin.close()
  try:cat.wait(timeout=5)
  except subprocess.TimeoutExpired:cat.kill();cat.wait()

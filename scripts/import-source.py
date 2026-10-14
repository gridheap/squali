#!/usr/bin/env python3
"""Bounded native Git -> Squali source ingestion. Reuse --state after interruption."""
import argparse,fcntl,base64,gzip,hashlib,json,os,pathlib,subprocess,sys,time,urllib.request,urllib.error
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('project');p.add_argument('repository');p.add_argument('--state',required=True)
p.add_argument('--max-objects',type=int,default=500000);p.add_argument('--max-bytes',type=int,default=16*1024**3)
p.add_argument('--max-requests',type=int,default=12000);p.add_argument('--max-batches',type=int,default=128);p.add_argument('--max-seconds',type=int,default=900)
a=p.parse_args();base=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN')
if not token:raise SystemExit('Set SQUALI_TOKEN in the environment')
if not 1<=a.max_objects<=2000000 or not 1<=a.max_bytes<=100*1024**3 or not 1<=a.max_requests<=30000 or not 1<=a.max_batches<=10000 or not 1<=a.max_seconds<=7200:raise SystemExit('Invalid finite ingestion budgets')
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

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
http=urllib.request.build_opener(NoRedirect())
def call(suffix,body):
 if state['httpAttempts']>=a.max_requests:raise RuntimeError('Persistent HTTP attempt ceiling reached')
 state['httpAttempts']+=1;save();raw=body if isinstance(body,bytes) else json.dumps(body,separators=(',',':')).encode()
 request=urllib.request.Request(base+'/api/projects/'+urllib.parse.quote(a.project,safe='')+'/source/'+suffix,data=raw,headers={'Authorization':'Bearer '+token,'User-Agent':'Squali-Native-Import/1','Content-Type':'application/gzip' if isinstance(body,bytes) else 'application/json'})
 try:
  with http.open(request,timeout=60) as response:data=response.read(2*1024*1024+1)
 except urllib.error.HTTPError as e:
  try:code=json.loads(e.read(65536)).get('error','unknown')
  except Exception:code='unknown'
  raise RuntimeError('Source request failed: HTTP '+str(e.code)+' '+code) from None
 if len(data)>2*1024*1024:raise RuntimeError('Source response exceeds 2 MiB')
 return json.loads(data)

def exhausted():return batches>=a.max_batches or time.monotonic()-started>=a.max_seconds

def rows(path,skip):
 with open(path) as f:
  for _ in range(skip):
   if not f.readline():raise RuntimeError('Saved cursor exceeds the native manifest')
  while True:
   batch=[]
   for _ in range(128):
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
  for entries in rows(root/'commits.txt',state['commitsProcessed']):
   if exhausted():report();raise SystemExit(2)
   call('changesets',{'commits':[r[0] for r in entries]});state['commitsProcessed']+=len(entries);batches+=1;save()
  state['stage']='refs';save()
 if exhausted():report();raise SystemExit(2)
 call('finish',{'refs':refs,'defaultBranch':branch});state['stage']='complete';state['complete']=True;save();report()
except Exception as e:
 print(str(e),file=sys.stderr);report();raise SystemExit(1)
finally:
 if cat:
  cat.stdin.close()
  try:cat.wait(timeout=5)
  except subprocess.TimeoutExpired:cat.kill();cat.wait()

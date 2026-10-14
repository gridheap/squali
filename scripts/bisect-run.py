#!/usr/bin/env python3
"""Resume a bounded first-parent bisect. Exit 0 = good, 1..124 = bad, 125 = skip."""
import argparse,fcntl,hashlib,json,os,pathlib,re,shutil,signal,subprocess,sys,time,urllib.parse,urllib.request
if '--' not in sys.argv:raise SystemExit('Provide an explicit test command after --')
separator=sys.argv.index('--');command=sys.argv[separator+1:];p=argparse.ArgumentParser(description=__doc__)
p.add_argument('project');p.add_argument('good');p.add_argument('bad');p.add_argument('--state',required=True);p.add_argument('--file',action='append',required=True);p.add_argument('--steps',type=int,default=8);p.add_argument('--test-seconds',type=int,default=60)
a=p.parse_args(sys.argv[1:separator]);origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN')
if not token or not command or len(command)>32 or not 1<=a.steps<=64 or not 1<=a.test_seconds<=300 or not 1<=len(a.file)<=32:raise SystemExit('Use finite test limits, 1–32 files, and SQUALI_TOKEN')
if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.project) or any(not re.fullmatch('[a-f0-9]{40}',oid) for oid in (a.good,a.bad)):raise SystemExit('Use immutable commit IDs and a valid project')
for name in a.file:
 if not name or name.startswith('/') or '\\' in name or any(part in ('','.','..','.git','.squali') for part in name.split('/')) or any(ord(c)<32 for c in name):raise SystemExit('Unsafe sparse file path')
os.umask(0o077);root=pathlib.Path(a.state).resolve();root.mkdir(parents=True,exist_ok=True);lock=open(root/'bisect.lock','a+')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('Another bisect process holds this journal')
identity={'origin':origin,'project':a.project,'good':a.good,'bad':a.bad,'files':sorted(set(a.file)),'command':command,'testSeconds':a.test_seconds};fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest();journal=root/'state.json'
s=json.loads(journal.read_text()) if journal.exists() else {'identity':identity,'fingerprint':fingerprint,'state':'running','good':a.good,'bad':a.bad,'tests':0,'httpAttempts':0,'downloadedBytes':0,'results':{},'culprit':None}
if s['fingerprint']!=fingerprint:raise SystemExit('Source, selected files, command or test timeout changed; keep the original journal')
def save():
 temporary=journal.with_suffix('.tmp')
 with open(temporary,'w') as out:out.write(json.dumps(s,indent=2)+'\n');out.flush();os.fsync(out.fileno())
 os.replace(temporary,journal)
def report(reused=False):print(json.dumps({k:s[k] for k in ('state','good','bad','tests','httpAttempts','downloadedBytes','culprit')}|{'reused':reused}))
if s['state']=='complete':report(True);raise SystemExit(0)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
http=urllib.request.build_opener(NoRedirect());cache=root/'blobs';cache.mkdir(exist_ok=True);steps=0

def call(path,body=None,binary=False):
 if s['httpAttempts']>=512:raise RuntimeError('Persistent 512-request budget exhausted')
 s['httpAttempts']+=1;save();request=urllib.request.Request(origin+'/api/projects/'+a.project+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Squali-Bisect/1'})
 with http.open(request,timeout=30) as response:
  data=response.read(1024*1024+1)
  if len(data)>1024*1024:raise RuntimeError('Bisect response exceeds 1 MiB')
 return data if binary else json.loads(data)

def materialize(oid):
 target=root/'workspace'
 if target.exists():shutil.rmtree(target)
 target.mkdir();trees={};total=0
 for path in identity['files']:
  parent,_,name=path.rpartition('/')
  if parent not in trees:trees[parent]=call('/tree?'+urllib.parse.urlencode({'ref':oid,'path':parent}))['entries']
  item=next((r for r in trees[parent] if r['name']==name),None)
  if item is None:continue # A test may intentionally observe a file added or removed in this range.
  if item['type']!='blob' or item['mode'] not in ('100644','100755'):raise RuntimeError('Bisect materializes regular files only')
  blob=cache/item['oid'];data=blob.read_bytes() if blob.exists() else None
  if data is not None and hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=item['oid']:raise RuntimeError('Bisect cache identity mismatch')
  if data is None:
   data=call('/blob?'+urllib.parse.urlencode({'ref':oid,'path':path}),binary=True)
   if hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=item['oid']:raise RuntimeError('Source identity mismatch')
   s['downloadedBytes']+=len(data);save()
   if s['downloadedBytes']>64*1024*1024:raise RuntimeError('Persistent 64 MiB download budget exhausted')
   temp=blob.with_suffix('.tmp');temp.write_bytes(data);os.replace(temp,blob)
  total+=len(data)
  if total>16*1024*1024:raise RuntimeError('Sparse test checkout exceeds 16 MiB')
  dest=target/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);dest.chmod(0o755 if item['mode']=='100755' else 0o644)
 return target

def classify(oid):
 global steps
 if oid in s['results']:return s['results'][oid]['classification']
 if steps>=a.steps:s['state']='paused';save();report();raise SystemExit(2)
 if s['tests']>=64:raise RuntimeError('Persistent 64-test budget exhausted')
 target=materialize(oid);steps+=1;s['tests']+=1;save();began=time.monotonic();log=root/(oid+'.log')
 # Commands are explicit caller input. This is a test runner, not a sandbox for untrusted code.
 environment={k:os.environ[k] for k in ('PATH','LANG','LC_ALL','TMPDIR','SYSTEMROOT') if k in os.environ}
 with open(log,'wb') as output:
  child=subprocess.Popen(command,cwd=target,env=environment,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   while child.poll() is None:
    if time.monotonic()-began>a.test_seconds or log.stat().st_size>1024*1024:raise RuntimeError('Test exceeded its time or 1 MiB output budget')
    time.sleep(0.05)
   code=child.returncode
   if code==125 or code<0 or code>=126:raise RuntimeError('Test is inconclusive; no good/bad result was recorded')
  finally:
   if child.poll() is None:
    os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=2)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 classification='good' if code==0 else 'bad';s['results'][oid]={'classification':classification,'exit':code,'seconds':round(time.monotonic()-began,3),'log':log.name};save();return classification
try:
 s['state']='running'
 if classify(a.good)!='good' or classify(a.bad)!='bad':raise RuntimeError('The supplied command does not reproduce the good/bad boundary')
 while True:
  plan=call('/bisect',{'good':s['good'],'bad':s['bad']})
  if plan.get('culprit'):s.update(state='complete',culprit=plan['culprit']);save();report();break
  candidate=plan.get('candidate')
  if not candidate:raise RuntimeError('There is no first-parent interval to bisect')
  s[classify(candidate)]=candidate;save()
except Exception as error:
 s['state']='stopped';save();report();print(str(error) if isinstance(error,RuntimeError) else 'Bisect stopped: '+type(error).__name__,file=sys.stderr);raise SystemExit(1)

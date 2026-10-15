#!/usr/bin/env python3
"""Upload one retained native Git pack as a bounded R2 compatibility snapshot."""
import argparse,fcntl,hashlib,http.client,json,os,pathlib,re,struct,subprocess,sys,time,urllib.parse
p=argparse.ArgumentParser(description=__doc__);p.add_argument('project');p.add_argument('repository');p.add_argument('--state',required=True);p.add_argument('--max-seconds',type=int,default=1800);a=p.parse_args()
if not 1<=a.max_seconds<=3600:raise SystemExit('Use a finite snapshot time budget up to one hour')
os.umask(0o077);root=pathlib.Path(a.state);journal=root/'state.json';lock=open(root/'import.lock','a+')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('The retained import journal is in use')
s=json.loads(journal.read_text());identity=s['identity'];repo=pathlib.Path(a.repository).resolve();origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN');url=urllib.parse.urlparse(origin)
if not token or url.scheme not in ('http','https') or url.username or url.password or url.query or url.fragment or identity['origin']!=origin or identity['project']!=a.project or identity['repository']!=str(repo):raise SystemExit('Use the original source endpoint, project, repository and a scoped credential')
if s['objectsProcessed']!=s['sourceObjects'] or s['commitsProcessed']!=len((root/'commits.txt').read_text().splitlines()):raise SystemExit('Finish canonical source ingestion first')
started=time.monotonic();http=(http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection)(url.hostname,url.port,timeout=90)
snapshot=s.setdefault('snapshot',{'attempts':0,'elapsedSeconds':0,'uploadedBytes':0,'indexed':0,'complete':False})
def save():
 path=journal.with_suffix('.tmp')
 with open(path,'w') as f:json.dump(s,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
 os.replace(path,journal)
def report(reused=False):print(json.dumps({k:s[k] for k in ('stage','objectsProcessed','commitsProcessed','httpAttempts','uploadedBytes','complete')}|{'snapshot':snapshot,'reused':reused}))
if snapshot['complete']:report(True);raise SystemExit(0)
if snapshot['attempts']>=2 or snapshot['elapsedSeconds']>=3600:raise SystemExit('Inspect the retained snapshot journal; its attempt/time ceiling is exhausted')
snapshot['attempts']+=1;save()
def git(*args):
 r=subprocess.run(['git','-C',str(repo),*args],capture_output=True,timeout=180)
 if r.returncode:raise RuntimeError('Native snapshot preparation failed')
 return r.stdout.decode().strip()
def call(suffix,body):
 if s['httpAttempts']>=identity['maxRequests'] or time.monotonic()-started>=a.max_seconds or snapshot['elapsedSeconds']+time.monotonic()-started>=3600:raise RuntimeError('Retained source HTTP or snapshot time budget exhausted')
 s['httpAttempts']+=1;save();raw=body if isinstance(body,bytes) else json.dumps(body,separators=(',',':')).encode()
 http.request('POST',url.path+'/api/projects/'+a.project+'/source/'+suffix,body=raw,headers={'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream' if isinstance(body,bytes) else 'application/json','User-Agent':'Squali-Git-Snapshot/1'})
 response=http.getresponse();data=response.read(2*1024*1024+1)
 if len(data)>2*1024*1024:raise RuntimeError('Snapshot response exceeds its bound')
 value=json.loads(data)
 if not 200<=response.status<300:raise RuntimeError('Snapshot stopped: HTTP '+str(response.status)+' '+str(value.get('error','unknown')))
 return value
try:
 refs=[dict(zip(('name','oid'),line.split(' '))) for line in git('for-each-ref','--format=%(refname) %(objectname)','refs/heads','refs/tags').splitlines()]
 if refs!=identity['refs'] or git('symbolic-ref','--short','HEAD')!=identity['branch']:raise RuntimeError('Frozen source refs changed')
 packdir=pathlib.Path(git('rev-parse','--git-path','objects/pack'));packdir=packdir if packdir.is_absolute() else repo/packdir;packs=list(packdir.glob('pack-*.pack'))
 if len(packs)!=1:raise RuntimeError('This bounded snapshot requires exactly one retained complete native pack')
 pack=packs[0];packid=pack.stem.removeprefix('pack-');index=pack.with_suffix('.idx')
 if not re.fullmatch('[a-f0-9]{40}',packid) or not index.exists() or pack.stat().st_size>512*1024**2 or index.stat().st_size>16*1024**2:raise RuntimeError('Retained pack or index exceeds snapshot admission')
 ids=[line.split()[0] for line in (root/'objects.txt').read_text().splitlines()];known=set(ids);idx=index.read_bytes()
 if len(idx)<1072 or idx[:8]!=b'\xfftOc\x00\x00\x00\x02' or struct.unpack('>I',idx[1028:1032])[0]!=len(ids) or idx[-40:-20].hex()!=packid or hashlib.sha1(idx[:-20]).digest()!=idx[-20:]:raise RuntimeError('Native index identity differs')
 packed={idx[1032+i*20:1052+i*20].hex() for i in range(len(ids))}
 if packed!=known:raise RuntimeError('Retained pack does not contain the complete canonical source inventory')
 manifest={'version':1,'packId':packid,'objects':len(ids),'refs':refs,'defaultBranch':identity['branch']};locations={};packhash=hashlib.sha1();tail=b''
 for name,path in [('pack',pack),('index',index)]:
  chunks=[];offset=0
  with path.open('rb') as f:
   while data:=f.read(8*1024**2):
    h=hashlib.sha256(data).hexdigest();chunks.append({'hash':h,'bytes':len(data)});locations.setdefault(h,(path,offset,len(data)));offset+=len(data)
    if name=='pack':
     joined=tail+data;packhash.update(joined[:-20]);tail=joined[-20:]
  manifest[name]={'bytes':offset,'chunks':chunks}
 if tail.hex()!=packid or packhash.hexdigest()!=packid:raise RuntimeError('Retained pack checksum differs')
 fingerprint=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
 if snapshot.get('fingerprint',fingerprint)!=fingerprint:raise RuntimeError('Retained snapshot identity changed')
 snapshot['fingerprint']=fingerprint;snapshot['packBytes']=manifest['pack']['bytes'];snapshot['indexBytes']=manifest['index']['bytes'];save()
 prepared=call('snapshot/prepare',manifest)
 if any(h not in locations for h in prepared['missing']):raise RuntimeError('Provider requested an unknown chunk')
 for h in prepared['missing']:
  path,offset,n=locations[h]
  with path.open('rb') as f:f.seek(offset);data=f.read(n)
  result=call('snapshot/part/'+h,data)
  if not result.get('reused'):snapshot['uploadedBytes']+=n
  save()
 for at in range(snapshot['indexed'],len(ids),2000):call('snapshot/index',{'oids':ids[at:at+2000]});snapshot['indexed']=min(len(ids),at+2000);save()
 call('snapshot/complete',{});snapshot['ready']=True;save()
 call('finish',{'refs':refs,'defaultBranch':identity['branch'],'gitBridgeLimited':True})
 snapshot['complete']=True;s['bridgeLimited']={'reason':'provider_storage_limit','compatibility':'r2_snapshot'};s['stage']='complete';s['complete']=True;save()
except Exception as error:
 snapshot['lastError']=str(error) if isinstance(error,RuntimeError) else type(error).__name__;raise SystemExit(snapshot['lastError'])
finally:
 snapshot['elapsedSeconds']=round(snapshot['elapsedSeconds']+time.monotonic()-started,3);save();http.close()
report()

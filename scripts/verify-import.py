#!/usr/bin/env python3
"""Verify a complete source import against a retained native repository, once."""
import argparse,base64,fcntl,hashlib,http.client,json,os,pathlib,re,shlex,subprocess,sys,time,urllib.parse
p=argparse.ArgumentParser(description=__doc__);p.add_argument('project');p.add_argument('native');p.add_argument('--state',required=True);p.add_argument('--file',required=True);a=p.parse_args()
origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN');u=urllib.parse.urlparse(origin)
if not token or u.scheme not in ('http','https') or u.username or u.password or u.query or u.fragment or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.project):raise SystemExit('Use a valid endpoint/project and SQUALI_TOKEN')
if a.file.startswith('/') or any(part in ('','.','..','.git') for part in a.file.split('/')):raise SystemExit('Use one safe repository-relative text file')
os.umask(0o077);root=pathlib.Path(a.state).resolve();root.mkdir(parents=True,exist_ok=True);lock=open(root/'verify.lock','a+')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('Another verification holds this journal')
def git(repo,*args):
 result=subprocess.run(['git','-C',str(repo),*args],capture_output=True,timeout=600 if args[0]=='fsck' else 180)
 if result.returncode:raise RuntimeError('Native Git validation failed: '+args[0])
 if len(result.stdout)>64*1024*1024:raise RuntimeError('Native output exceeds 64 MiB')
 return result.stdout
def refs(repo):return sorted(git(repo,'for-each-ref','--format=%(refname) %(objectname)','refs/heads','refs/tags').decode().splitlines())
native=pathlib.Path(a.native).resolve();expected_refs=refs(native);head=git(native,'rev-parse','HEAD').decode().strip();identity={'origin':origin,'project':a.project,'native':str(native),'head':head,'refs':expected_refs,'file':a.file}
fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest();journal=root/'state.json';s=json.loads(journal.read_text()) if journal.exists() else {'identity':identity,'fingerprint':fingerprint,'httpAttempts':0,'gitTransfers':0,'steps':{},'report':None}
if s['fingerprint']!=fingerprint:raise SystemExit('Verification source changed; retain the original journal')
if s['report']:print(json.dumps(s['report']));raise SystemExit(0)
def save():
 temp=journal.with_suffix('.tmp')
 with open(temp,'w') as out:out.write(json.dumps(s,indent=2)+'\n');out.flush();os.fsync(out.fileno())
 os.replace(temp,journal)
http=(http.client.HTTPSConnection if u.scheme=='https' else http.client.HTTPConnection)(u.hostname,u.port,timeout=90)
def call(key,path,body=None):
 if key in s['steps']:return s['steps'][key]
 if s['httpAttempts']>=40:raise RuntimeError('Persistent 40-request verification budget exhausted')
 s['httpAttempts']+=1;save();http.request('GET' if body is None else 'POST',u.path+'/api/projects/'+a.project+path,body=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Squali-Import-Verification/1'})
 r=http.getresponse();raw=r.read(2*1024*1024+1)
 if len(raw)>2*1024*1024:raise RuntimeError('Response exceeds 2 MiB')
 value=json.loads(raw)
 if not 200<=r.status<300:raise RuntimeError('Verification stopped: HTTP '+str(r.status)+' '+str(value.get('error','unknown')))
 s['steps'][key]=value;save();return value
try:
 project=call('project','');assert project['state']=='ready' and project['head']==head,'Import must be complete at its frozen head'
 source=call('source','/source');assert source['gitCompatibility']['state']!='provider_limit','Git compatibility is limited'
 assert sorted(r['name']+' '+r['oid'] for r in source['refs'])==expected_refs,'Source refs differ'
 expected_objects=sorted(set(git(native,'rev-list','--objects','--all','--no-object-names').decode().splitlines()));commits=int(git(native,'rev-list','--all','--count'))
 assert source['objects']==len(expected_objects) and source['changesets']==commits,'Source inventory is incomplete'
 assert call('index','/index?ref='+head)['complete'],'Graph is incomplete'
 commit=call('commit','/commit?ref='+head);assert commit['tree']==git(native,'rev-parse',head+'^{tree}').decode().strip()
 tree=call('tree','/tree?ref='+head)['entries'];native_tree=[]
 for record in git(native,'ls-tree','-z',head).split(b'\0'):
  if not record:continue
  metadata,name=record.split(b'\t',1);mode,kind,oid=metadata.decode().split();native_tree.append((name.decode(),kind,oid,str(int(mode)) if mode=='040000' else mode))
 assert sorted((e['name'],e['type'],e['oid'],e['mode']) for e in tree)==sorted(native_tree),'Root tree differs'
 file=call('file','/file?'+urllib.parse.urlencode({'ref':head,'path':a.file}));expected_file=git(native,'show',head+':'+a.file);assert file['content'].encode()==expected_file,'Sparse content differs'
 distance=min(1024,int(git(native,'rev-list','--first-parent','--count',head))-1)
 if distance:
  good=git(native,'rev-parse',head+'~'+str(distance)).decode().strip();assert call('ancestry','/ancestry',{'ancestor':good,'descendant':head})['isAncestor'];assert call('merge-base','/merge-base',{'left':good,'right':head})['bases']==[good]
  bisect=call('bisect','/bisect',{'good':good,'bad':head});assert bisect.get('candidate') or bisect.get('culprit')==head
 history=call('history','/path-history?'+urllib.parse.urlencode({'ref':head,'path':a.file,'limit':10}));native_history=git(native,'log','--first-parent','--format=%H','-n','10',head,'--',a.file).decode().splitlines();assert [r['oid'] for r in history['commits']]==native_history,'Path history differs'
 blame=call('blame','/blame?'+urllib.parse.urlencode({'ref':head,'path':a.file}));native_blame=git(native,'blame','--root','--line-porcelain',head,'--',a.file).decode();origins=[(m.group(1),int(m.group(2))) for m in re.finditer(r'^([a-f0-9]{40}) (\d+) \d+(?: \d+)?$',native_blame,re.M)];assert [(r['commit'],r['originalLine']) for r in blame['lines']]==origins,'Blame differs from native Git'
 clone=root/'export.git'
 if not clone.exists():
  if s['gitTransfers']>=1:raise RuntimeError('The single Git transfer was already attempted; inspect its outcome before recovery')
  s['gitTransfers']+=1;save();http.close()
  env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_COUNT':'4','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+token,'GIT_CONFIG_KEY_1':'http.followRedirects','GIT_CONFIG_VALUE_1':'false','GIT_CONFIG_KEY_2':'pack.threads','GIT_CONFIG_VALUE_2':'1','GIT_CONFIG_KEY_3':'core.deltaBaseCacheLimit','GIT_CONFIG_VALUE_3':'32m','GIT_TRACE':'0','GIT_TRACE_CURL':'0','GIT_CURL_VERBOSE':'0'};env.pop('SQUALI_TOKEN',None)
  result=subprocess.run(['git','clone','--mirror',origin+'/api/projects/'+a.project+'/git',str(clone)],env=env,capture_output=True,timeout=600)
  if result.returncode:raise RuntimeError('Native clone stopped; retained partial data requires inspection')
 if not s.get('fsck'):
  output=git(clone,'fsck','--full');(root/'fsck.txt').write_bytes(output);s['fsck']=True;save()
 assert refs(clone)==expected_refs,'Exported refs differ'
 actual_objects=sorted(set(git(clone,'rev-list','--objects','--all','--no-object-names').decode().splitlines()));assert actual_objects==expected_objects,'Exported object closure differs'
 assert git(clone,'rev-parse','HEAD').decode().strip()==head,'Default branch differs'
 report={'command':shlex.join(['python3',*sys.argv]),'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'complete':True,'project':a.project,'head':head,'objects':len(expected_objects),'commits':commits,'refs':len(expected_refs),'objectInventorySha256':hashlib.sha256(('\n'.join(expected_objects)+'\n').encode()).hexdigest(),'nativeFsck':True,'rootTreeMatches':True,'sparseFile':a.file,'sparseFileSha256':hashlib.sha256(expected_file).hexdigest(),'historyMatchesNative':True,'blameMatchesNative':True,'firstParentDistance':distance,'httpAttempts':s['httpAttempts'],'gitTransfers':s['gitTransfers'],'limitations':['Full exported Git closure is verified; source R2 bodies are identity-checked on ingestion and sampled here','One selected file exercises history/blame; other files retain the documented query budgets','No automatic network retry; complete replay makes zero HTTP or Git transfers']}
 s['report']=report;save();(root/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
except Exception as error:raise SystemExit(str(error) if isinstance(error,(RuntimeError,AssertionError)) else 'Verification stopped: '+type(error).__name__)
finally:http.close()

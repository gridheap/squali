#!/usr/bin/env python3
"""One bounded source-storage acceptance run. A completed journal makes zero HTTP calls."""
import argparse,concurrent.futures,fcntl,hashlib,http.client,json,math,os,pathlib,re,shlex,sys,threading,time,urllib.parse

p=argparse.ArgumentParser(description=__doc__);p.add_argument('project');p.add_argument('--state',required=True);p.add_argument('--label',required=True);p.add_argument('--follow-up',action='store_true',help='Eight new changes in the existing baseline workspace');p.add_argument('--series',default='optimized',help='Stable identity for one justified follow-up after a material change');a=p.parse_args()
if not re.fullmatch('[a-z][a-z0-9]{0,19}',a.series) or (not a.follow_up and a.series!='optimized'):raise SystemExit('Use a short series identity only for a follow-up')
count=8 if a.follow_up else 64;request_cap=40 if a.follow_up else 160;change_prefix=a.series+'-agent-' if a.follow_up else 'agent-';file_prefix=a.series+'-' if a.follow_up else '';content_prefix=a.series if a.follow_up else 'agent'
origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');owner=os.environ.get('SQUALI_TOKEN');agent=os.environ.get('SQUALI_AGENT_TOKEN',owner)
endpoint=urllib.parse.urlparse(origin)
if not owner or not agent or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.project):raise SystemExit('Use credentials in the environment and a valid project ID')
if endpoint.scheme not in ('http','https') or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:raise SystemExit('Invalid endpoint')
os.umask(0o077);root=pathlib.Path(a.state);root.mkdir(parents=True,exist_ok=True);file_lock=open(root/'run.lock','a+')
try:fcntl.flock(file_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('Another acceptance process holds this journal')
identity={'origin':origin,'project':a.project,'label':a.label,'changes':count,'concurrency':8,'baselineFiles':64,'version':1,**({'followUp':True} if a.follow_up else {}),**({'series':a.series} if a.series!='optimized' else {})};fingerprint=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest();journal=root/'state.json'
s=json.loads(journal.read_text()) if journal.exists() else {'identity':identity,'fingerprint':fingerprint,'httpAttempts':0,'operations':{},'segments':0,'report':None}
if s['fingerprint']!=fingerprint:raise SystemExit('Acceptance inputs changed; retain this journal')
if s['report']:print(json.dumps(s['report']));raise SystemExit(0)
guard=threading.RLock();local=threading.local();connections=[]
def save():
 temporary=journal.with_suffix('.tmp')
 with open(temporary,'w') as out:out.write(json.dumps(s,indent=2)+'\n');out.flush();os.fsync(out.fileno())
 os.replace(temporary,journal)
s['segments']+=1;save()
def call(key,path,body=None,as_agent=False):
 request_hash=hashlib.sha256(json.dumps([path,body,as_agent],sort_keys=True).encode()).hexdigest()
 with guard:
  previous=s['operations'].get(key,{})
  if previous and previous['hash']!=request_hash:raise RuntimeError('Saved request identity changed')
  if previous.get('complete'):return previous['body']
  if s['httpAttempts']>=request_cap or previous.get('attempts',0)>=3:raise RuntimeError('Persistent request budget exhausted')
  s['httpAttempts']+=1;record={'hash':request_hash,'attempts':previous.get('attempts',0)+1,'complete':False,'start':time.time()};s['operations'][key]=record;save()
 if not hasattr(local,'http'):
  local.http=(http.client.HTTPSConnection if endpoint.scheme=='https' else http.client.HTTPConnection)(endpoint.hostname,endpoint.port,timeout=60)
  with guard:connections.append(local.http)
 raw=None if body is None else json.dumps(body,separators=(',',':')).encode();started=time.monotonic()
 try:
  local.http.request('GET' if body is None else 'POST',endpoint.path+'/api'+path,body=raw,headers={'Authorization':'Bearer '+(agent if as_agent else owner),'Content-Type':'application/json','User-Agent':'Squali-Bounded-Acceptance/1'})
  response=local.http.getresponse();data=response.read(2*1024*1024+1)
  if len(data)>2*1024*1024:raise RuntimeError('Response exceeds 2 MiB')
  value=json.loads(data)
  if not 200<=response.status<300:raise RuntimeError('HTTP '+str(response.status)+' '+str(value.get('error','unknown')))
  with guard:record.update(complete=True,body=value,ms=round((time.monotonic()-started)*1000,3),end=time.time(),status=response.status);save()
  return value
 except Exception as error:
  local.http.close()
  with guard:record['error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__;save()
  raise RuntimeError('Acceptance stopped at '+key+': '+record['error']) from None

def parallel(fn):
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
  jobs=[executor.submit(fn,i) for i in range(count)]
  try:
   for job in concurrent.futures.as_completed(jobs):job.result()
  except BaseException:
   for job in jobs:job.cancel()
   raise

try:
 before=call('usage-before','/usage');prefix='/projects/'+a.project
 files=[{'path':'seed/file-'+str(i)+'.txt','content':('immutable baseline '+str(i)+'\n')*300} for i in range(64)]
 created=call('existing',prefix) if a.follow_up else call('create','/projects',{'id':a.project,'name':'Bounded source acceptance','storage':'source','files':files})
 initial_count=call('source-before',prefix+'/source')['changesets'] if a.follow_up else 1
 assert created['storage']=='source'
 parallel(lambda i:call('change-'+str(i),prefix+'/changes',{'id':change_prefix+str(i),'title':'Agent '+str(i),'intent':'Independent bounded performance fixture','context':{'fixture':True},'files':[{'path':'agents/'+file_prefix+str(i)+'.ts','content':'export const '+content_prefix+str(i)+' = '+str(i)+';\n'}]},True))
 parallel(lambda i:call('review-'+str(i),prefix+'/changes/'+change_prefix+str(i)+'/review',{'decision':'approved','note':'Bounded acceptance fixture'}))
 prepublish=call('usage-prepublish','/usage');published=call('publish',prefix+'/publish',{'id':a.series+'-batch-0' if a.follow_up else 'batch-0','changes':[change_prefix+str(i) for i in range(count)],'expectedHead':created['head']})
 tree=call('tree',prefix+'/tree?path=agents');status=call('source',prefix+'/source')
 published_files=sum(1 for entry in tree['entries'] if entry['name'] in {file_prefix+str(i)+'.ts' for i in range(count)})
 assert published_files==count and len(status['refs'])==1 and status['changesets']==initial_count+count+1
 if a.follow_up:assert call('new-file',prefix+'/file?path=agents/'+file_prefix+'0.ts')['content']=='export const '+content_prefix+'0 = 0;\n'
 samples=[]
 for i in (() if a.follow_up else (0,15,31,63)):
  path=prefix+'/file?'+urllib.parse.urlencode({'path':'seed/file-'+str(i)+'.txt','ref':published['oid']})
  cold=call('cold-'+str(i),path);warm=call('warm-'+str(i),path);assert cold['content']==files[i]['content'] and warm==cold
  samples.append({'file':files[i]['path'],'firstMs':s['operations']['cold-'+str(i)]['ms'],'repeatMs':s['operations']['warm-'+str(i)]['ms']})
 after=call('usage-after','/usage');writes=[s['operations']['change-'+str(i)] for i in range(count)];ordered=sorted(r['ms'] for r in writes);wall=(max(r['end'] for r in writes)-min(r['start'] for r in writes))*1000
 def percentile(p):return ordered[min(count-1,math.ceil(count*p)-1)]
 report={'command':shlex.join(['python3',*sys.argv]),'label':a.label,'origin':origin,'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'complete':True,'httpAttempts':s['httpAttempts'],'segments':s['segments'],'dataset':{'baselineFiles':64,'baselineBytes':sum(len(f['content'].encode()) for f in files),'changes':count,'concurrency':8,'storage':'source'},'results':{'publishedFiles':published_files,'changesets':status['changesets'],'writeWallMs':round(wall,3),'changesPerSecond':round(count*1000/wall,3),'p50Ms':percentile(.5),'p95Ms':percentile(.95),'p99Ms':percentile(.99),'publicationMs':s['operations']['publish']['ms'],'publishedHead':published['oid'],'cacheSamples':samples,'usageBefore':before,'usageBeforePublication':prepublish,'usageAfter':after},'limitations':['One origin client location and small independent text changes; no distributed-scale claim','Usage counters are shared deployment reservations; concurrent import traffic is included','First/repeat reads do not imply an empty global cache or isolate','Eight clients share the supplied agent principal; this is not an eight-user identity benchmark','No automatic retries; resumed write wall time includes pauses between segments']}
 s['report']=report;save();(root/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
except Exception as error:raise SystemExit(str(error) if isinstance(error,RuntimeError) else 'Acceptance invariant failed: '+type(error).__name__)
finally:
 for http in connections:http.close()

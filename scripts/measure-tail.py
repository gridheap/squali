#!/usr/bin/env python3
"""Bounded before/after submission tails. Persistent pilot/resume; no automatic retry."""
import argparse,concurrent.futures,fcntl,hashlib,http.client,json,math,os,pathlib,re,shlex,statistics,sys,threading,time,urllib.parse

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('project');p.add_argument('--state',required=True);p.add_argument('--phase',choices=['before','after','verify'],required=True);p.add_argument('--deployment',required=True)
p.add_argument('--samples',type=int,default=256);p.add_argument('--concurrency',type=int,default=8);p.add_argument('--through',type=int);p.add_argument('--resume',action='store_true')
a=p.parse_args();through=a.through or a.samples;origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN');url=urllib.parse.urlparse(origin)
if not token or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.project) or url.scheme not in ('http','https') or not url.hostname or url.username or url.password:raise SystemExit('Invalid endpoint/project or missing credential environment')
if not 8<=a.samples<=256 or not 1<=a.concurrency<=8 or not 1<=through<=a.samples:raise SystemExit('Bound samples to 8–256 and concurrency to 1–8')
os.umask(0o077);root=pathlib.Path(a.state);root.mkdir(parents=True,exist_ok=True);lock=open(root/'run.lock','a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
file=root/'state.json';identity={'origin':origin,'project':a.project,'version':1,'samplesPerPhase':a.samples,'concurrency':a.concurrency,'maxRequests':640,'series':'tail-v1'}
s=json.loads(file.read_text()) if file.exists() else {'identity':identity,'httpAttempts':0,'operations':{},'phases':{}}
if s['identity']!=identity:raise SystemExit('Journal identity changed')
previous=s['phases'].get(a.phase,{})
if previous and previous['deployment']!=a.deployment:raise SystemExit('Deployment identity changed within a phase')
if previous.get('complete'):print(json.dumps(previous));raise SystemExit(0)
guard=threading.RLock();local=threading.local();connections=[];stop=threading.Event()
def save():
 tmp=file.with_suffix('.tmp')
 with open(tmp,'w') as out:out.write(json.dumps(s,indent=2)+'\n');out.flush();os.fsync(out.fileno())
 os.replace(tmp,file)
def call(key,path,body=None):
 fingerprint=hashlib.sha256(json.dumps([path,body],sort_keys=True).encode()).hexdigest()
 with guard:
  record=s['operations'].get(key)
  if record:
   if record['fingerprint']!=fingerprint:raise RuntimeError('Request identity changed')
   if record.get('complete'):return record['body']
   if not a.resume:raise RuntimeError('Inspect failed/ambiguous operation before explicit --resume')
  if stop.is_set():raise RuntimeError('Dispatch stopped after a failure')
  record=record or {'fingerprint':fingerprint,'attempts':[]};s['operations'][key]=record
  if s['httpAttempts']>=640 or len(record['attempts'])>=3:raise RuntimeError('Persistent attempt ceiling reached')
  attempt={'started':time.time()};record['attempts'].append(attempt);s['httpAttempts']+=1;save()
 if not hasattr(local,'connection'):
  local.connection=(http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection)(url.hostname,url.port,timeout=30)
  with guard:connections.append(local.connection)
 start=time.monotonic()
 try:
  local.connection.request('GET' if body is None else 'POST',url.path+'/api'+path,body=None if body is None else json.dumps(body,separators=(',',':')),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-Squali-Timing':'1','User-Agent':'Squali-Bounded-Tail/1'})
  response=local.connection.getresponse();raw=response.read(2*1024*1024+1)
  if len(raw)>2*1024*1024:raise RuntimeError('Response exceeds bound')
  stages={}
  for part in (response.getheader('server-timing') or '').split(','):
   match=re.fullmatch(r'\s*([a-z0-9_]+);dur=([0-9.]+)\s*',part)
   if match:stages[match[1]]=float(match[2])
  attempt.update(status=response.status,clientMs=round((time.monotonic()-start)*1000,3),stages=stages,ray=response.getheader('cf-ray'),ended=time.time());value=json.loads(raw)
  if not 200<=response.status<300:raise RuntimeError('HTTP '+str(response.status)+' '+str(value.get('error','unknown')))
  with guard:record.update(complete=True,body=value);save()
  return value
 except Exception as error:
  stop.set();local.connection.close()
  with guard:attempt.update(error=str(error) if isinstance(error,RuntimeError) else type(error).__name__,clientMs=round((time.monotonic()-start)*1000,3),ended=time.time());save()
  raise RuntimeError(key+': '+attempt['error']) from None
def quantiles(values):
 ordered=sorted(values);n=len(ordered)
 return {'n':n,'p50':statistics.median(ordered),'p95':ordered[math.ceil(n*.95)-1],'p99':ordered[math.ceil(n*.99)-1],'max':ordered[-1],'method':'nearest rank (p95/p99)'}
prefix='/projects/'+a.project
def payload(phase,i):
 tag='tail-v1-'+phase[0]+'-'+str(i).zfill(3)
 return {'id':tag,'title':'Tail latency fixture','intent':'Bounded fixed-base submission measurement','base':s['base'],'context':{'fixture':True},'files':[{'path':'tails/'+tag+'.txt','content':('immutable tail fixture '+tag+'\n')*16}]}
def samples(phase):
 result=[]
 for i in range(through):
  record=s['operations'].get(phase+'-'+str(i),{})
  if not record.get('complete'):continue
  # Keep the original request outcome, including failures; never replace an
  # ambiguous first attempt with an artificially fast idempotent replay.
  first=record['attempts'][0];result.append({'id':record['body']['id'],'oid':record['body']['oid'],'attemptCount':len(record['attempts']),**first})
 return result
try:
 phase=s['phases'].setdefault(a.phase,{'deployment':a.deployment,'commands':[],'complete':False});phase['commands'].append(shlex.join(['python3',*sys.argv]));save()
 if a.phase in ('before','after'):
  if a.phase=='after' and not s['phases'].get('before',{}).get('complete'):raise RuntimeError('Complete baseline before changing versions')
  before=call(a.phase+'-usage-start','/usage')
  if 'base' not in s:
   project=call('project',prefix);assert project['storage']=='source';s['base']=project['head'];save()
  def propose(i):
   value=call(a.phase+'-'+str(i),prefix+'/changes',payload(a.phase,i));assert value['status']=='proposed';return value
  with concurrent.futures.ThreadPoolExecutor(max_workers=a.concurrency) as pool:
   jobs=[pool.submit(propose,i) for i in range(through)]
   for job in concurrent.futures.as_completed(jobs):job.result()
  observed=samples(a.phase)
  if a.phase=='after':
   first=payload('after',0);f=first['files'][0];oid=s['operations']['after-0']['body']['oid']
   assert call('after-pilot-read',prefix+'/file?'+urllib.parse.urlencode({'path':f['path'],'ref':oid}))['content']==f['content'],'Uploaded draft must be readable before publication or full-run expansion'
  after=call(a.phase+'-usage-'+str(through),'/usage')
  assert len(observed)==through;assert after['source']['writes']-before['source']['writes']==through;assert after['attempts']==before['attempts']
  assert all('app' in x.get('stages',{}) or x.get('error') for x in observed),'Missing source timings'
  successful=[x for x in observed if not x.get('error')]
  # All first attempts, failures included, remain in client statistics. Stage
  # statistics explicitly count only responses that supplied that stage.
  stageNames=set().union(*(x.get('stages',{}) for x in successful))
  stageValues={name:[x['stages'][name] for x in successful if name in x['stages']] for name in stageNames}
  stageValues['outside_source']=[max(0,x['clientMs']-x['stages']['worker']) for x in successful if 'worker' in x['stages']]
  stageValues['forward_overhead']=[max(0,x['stages']['regional']-x['stages']['worker']) for x in successful if 'regional' in x['stages'] and 'worker' in x['stages']]
  phase.update(complete=through==a.samples,samples=observed,client=quantiles([x['clientMs'] for x in observed]),stages={name:quantiles(values) for name,values in stageValues.items() if values},failures=sum(bool(x.get('error')) for x in observed),usageStart=before,usageEnd=after);save()
 else:
  assert all(s['phases'].get(x,{}).get('complete') for x in ('before','after'))
  assert call('head-before-publish',prefix)['head']==s['base'],'Proposal moved main'
  selected=sorted({0,a.samples//3,2*a.samples//3,a.samples-1});changes=[payload(phase,i) for phase in ('before','after') for i in selected]
  for change in changes:call('review-'+change['id'],prefix+'/changes/'+change['id']+'/review',{'decision':'approved','note':'Bounded tail fixture'})
  published=call('publish',prefix+'/publish',{'id':'tail-v1-publish','changes':[c['id'] for c in changes],'expectedHead':s['base']})
  for change in changes:
   f=change['files'][0];assert call('file-'+change['id'],prefix+'/file?'+urllib.parse.urlencode({'path':f['path'],'ref':published['oid']}))['content']==f['content']
  after=call('final-usage','/usage');before=s['phases']['before']['usageStart'];phase.update(complete=True,verifiedFiles=len(changes),publishedHead=published['oid']);save()
  report={**identity,'httpAttempts':s['httpAttempts'],'phases':s['phases'],'verifiedFiles':len(changes),'publishedHead':published['oid'],'failures':sum(bool(x.get('error')) for r in s['operations'].values() for x in r['attempts']),'usageDelta':{'writes':after['source']['writes']-before['source']['writes'],'reads':after['source']['reads']-before['source']['reads'],'artifacts':after['attempts']-before['attempts']},'limitations':['Empirical nearest-rank percentiles for this sample; not a fleet SLO','Same local client, principal, frozen base, content size and concurrency; distinct immutable files','All first attempts retained; retry outcomes never replace them','Nested timings overlap; Worker clock is not CPU measurement','Server response forwarding is included in regional span; client transport is separate','Eight selected changes published; all other fixture changes remain proposed']}
  (root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in s['phases'][a.phase].items() if k!='samples'}))
except Exception as error:raise SystemExit(str(error))
finally:
 for connection in connections:connection.close()

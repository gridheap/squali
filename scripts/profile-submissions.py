#!/usr/bin/env python3
"""Four sequential submissions per version, frozen base, persistent 48-call ceiling.
No automatic retries. Reinvoking a completed phase makes zero network calls.
"""
import argparse,fcntl,hashlib,http.client,json,os,pathlib,re,shlex,statistics,sys,time,urllib.parse

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('project');p.add_argument('--state',required=True);p.add_argument('--phase',choices=['before','after','verify'],required=True);p.add_argument('--deployment',required=True);p.add_argument('--resume',action='store_true')
a=p.parse_args();origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN');url=urllib.parse.urlparse(origin)
if not token or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.project) or url.scheme not in ('https','http') or not url.hostname or url.username or url.password:raise SystemExit('Use a valid endpoint, project, and SQUALI_TOKEN environment variable')
os.umask(0o077);root=pathlib.Path(a.state);root.mkdir(parents=True,exist_ok=True);lock=open(root/'run.lock','a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
file=root/'state.json';identity={'origin':origin,'project':a.project,'version':1,'samplesPerPhase':4,'concurrency':1,'maxRequests':48}
s=json.loads(file.read_text()) if file.exists() else {'identity':identity,'operations':{},'phases':{},'httpAttempts':0}
if s['identity']!=identity:raise SystemExit('Journal identity changed')
if s['phases'].get(a.phase,{}).get('complete'):print(json.dumps(s['phases'][a.phase]));raise SystemExit(0)
def save():
 tmp=file.with_suffix('.tmp')
 with open(tmp,'w') as out:out.write(json.dumps(s,indent=2)+'\n');out.flush();os.fsync(out.fileno())
 os.replace(tmp,file)
connection=(http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection)(url.hostname,url.port,timeout=45)
def call(key,path,body=None):
 fingerprint=hashlib.sha256(json.dumps([path,body],sort_keys=True).encode()).hexdigest();previous=s['operations'].get(key)
 if previous:
  if previous['fingerprint']!=fingerprint:raise RuntimeError('Request identity changed')
  if previous.get('complete'):return previous['body']
  if not a.resume:raise RuntimeError('Inspect the failed/ambiguous operation; explicit --resume required')
 record=previous or {'fingerprint':fingerprint,'attempts':[]};s['operations'][key]=record
 if s['httpAttempts']>=48 or len(record['attempts'])>=3:raise RuntimeError('Persistent request ceiling reached')
 attempt={'started':time.time()};record['attempts'].append(attempt);s['httpAttempts']+=1;save();start=time.monotonic()
 try:
  connection.request('GET' if body is None else 'POST',url.path+'/api'+path,body=None if body is None else json.dumps(body,separators=(',',':')),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-Squali-Timing':'1','User-Agent':'Squali-Bounded-Stage-Profile/1'})
  response=connection.getresponse();raw=response.read(2*1024*1024+1)
  if len(raw)>2*1024*1024:raise RuntimeError('Response limit exceeded')
  stages={}
  for part in (response.getheader('server-timing') or '').split(','):
   match=re.fullmatch(r'\s*([a-z0-9_]+);dur=([0-9.]+)\s*',part)
   if match:stages[match[1]]=float(match[2])
  attempt.update(status=response.status,clientMs=round((time.monotonic()-start)*1000,3),stages=stages,ray=response.getheader('cf-ray'),ended=time.time());value=json.loads(raw)
  if not 200<=response.status<300:raise RuntimeError('HTTP '+str(response.status)+' '+str(value.get('error','unknown')))
  record.update(complete=True,body=value);save();return value
 except Exception as error:
  attempt['error']=str(error) if isinstance(error,RuntimeError) else type(error).__name__;save();connection.close();raise RuntimeError(key+': '+attempt['error']) from None

prefix='/projects/'+a.project
def input_for(phase,i):
 tag='latency-'+phase+'-'+str(i)
 return {'id':tag,'title':'Submission stage profile','intent':'Fixed-base bounded production latency measurement','base':s['base'],'context':{'fixture':True},'files':[{'path':'agents/'+tag+'.txt','content':('latency fixture '+phase.ljust(6)+' '+str(i)+'\n')*16}]}
try:
 phase=s['phases'].setdefault(a.phase,{'deployment':a.deployment,'command':shlex.join(['python3',*sys.argv])})
 if phase['deployment']!=a.deployment:raise RuntimeError('Phase deployment identity changed')
 save()
 if a.phase in ('before','after'):
  if a.phase=='after' and not s['phases'].get('before',{}).get('complete'):raise RuntimeError('Complete before phase first')
  usage=call(a.phase+'-usage-start','/usage')
  if 'base' not in s:
   project=call('project',prefix);assert project['storage']=='source';s['base']=project['head'];save()
  samples=[]
  for i in range(4):
   key=a.phase+'-'+str(i);body=call(key,prefix+'/changes',input_for(a.phase,i));assert body['status']=='proposed'
   attempt=s['operations'][key]['attempts'][-1];assert 'app' in attempt['stages'],'Missing request timings'
   samples.append({'id':body['id'],'oid':body['oid'],**attempt})
  after=call(a.phase+'-usage-end','/usage');assert after['source']['writes']-usage['source']['writes']==4;assert after['attempts']==usage['attempts']
  phase.update(complete=True,samples=samples,medianClientMs=statistics.median(x['clientMs'] for x in samples),medianStages={name:statistics.median(x['stages'][name] for x in samples if name in x['stages']) for name in set().union(*(x['stages'] for x in samples))},usageStart=usage,usageEnd=after);save()
 else:
  assert all(s['phases'].get(x,{}).get('complete') for x in ('before','after'))
  assert call('head-before-publish',prefix)['head']==s['base'],'Proposal moved main'
  changes=[input_for(phase,i) for phase in ('before','after') for i in range(4)]
  for change in changes:call('review-'+change['id'],prefix+'/changes/'+change['id']+'/review',{'decision':'approved','note':'Bounded stage profiling fixture'})
  published=call('publish',prefix+'/publish',{'id':'latency-profile-publish','changes':[c['id'] for c in changes],'expectedHead':s['base']})
  for change in changes:
   f=change['files'][0];assert call('file-'+change['id'],prefix+'/file?'+urllib.parse.urlencode({'path':f['path'],'ref':published['oid']}))['content']==f['content']
  after=call('final-usage','/usage');before=s['phases']['before']['usageStart'];phase.update(complete=True,publishedHead=published['oid'],verifiedFiles=8);save()
  report={**identity,'httpAttempts':s['httpAttempts'],'phases':s['phases'],'verifiedFiles':8,'publishedHead':published['oid'],'usageDelta':{'writes':after['source']['writes']-before['source']['writes'],'reads':after['source']['reads']-before['source']['reads'],'artifacts':after['attempts']-before['attempts']},'limitations':['Four sequential samples per version; median/range, not a fleet p95','Same local client, principal, frozen base and payload length; different immutable files','Nested stage durations overlap; worker timing excludes network transport and is not CPU','Shared deployment usage reservations may include concurrent callers']}
  (root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(s['phases'][a.phase]))
except Exception as error:raise SystemExit(str(error))
finally:connection.close()

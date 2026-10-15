#!/usr/bin/env python3
"""Four bounded route checks sharing the tail run's persistent 640-attempt budget.
Failure specification: new/legacy RPC skips the cache, recurses, returns wrong
bytes/head, or rerunning acceptance repeats fresh successful provider work.
"""
import argparse,fcntl,hashlib,http.client,json,os,pathlib,shlex,sys,time,urllib.parse
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--state',required=True);a=p.parse_args()
os.umask(0o077);root=pathlib.Path(a.state);lock=open(root/'run.lock','a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);file=root/'state.json';s=json.loads(file.read_text())
if s['phases'].get('routing',{}).get('complete'):print(json.dumps(s['phases']['routing']));raise SystemExit(0)
assert 'after-pilot-read' in s['operations'] and s['operations']['after-pilot-read']['complete'],'Read back the upload pilot first'
token=os.environ['SQUALI_TOKEN'];identity=s['identity'];url=urllib.parse.urlparse(identity['origin']);project=identity['project'];expected=s['operations']['after-pilot-read']['body'];prefix='/projects/'+project
connection=(http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection)(url.hostname,url.port,timeout=20)
def save():
 tmp=file.with_suffix('.tmp')
 with open(tmp,'w') as out:out.write(json.dumps(s,indent=2)+'\n');out.flush();os.fsync(out.fileno())
 os.replace(tmp,file)
steps=[]
try:
 for name,path,query in [('new-object','/regional'+prefix+'/rpc',{'op':'object','oid':expected['oid']}),('new-hit','/regional'+prefix+'/rpc',{'op':'object','oid':expected['oid']}),('legacy-object',prefix+'/rpc',{'op':'object','oid':expected['oid']}),('legacy-head',prefix+'/rpc',{'op':'head'})]:
  key='routing-'+name;fingerprint=hashlib.sha256(json.dumps([path,query],sort_keys=True).encode()).hexdigest();record=s['operations'].get(key)
  if record:
   assert record['fingerprint']==fingerprint
   if record.get('complete'):steps.append(record['body']);continue
   raise RuntimeError('Inspect failed/ambiguous routing check; no automatic retry')
  assert s['httpAttempts']<identity['maxRequests'];s['httpAttempts']+=1;attempt={'started':time.time()};s['operations'][key]={'fingerprint':fingerprint,'attempts':[attempt]};save();start=time.monotonic()
  try:
   connection.request('POST','/api'+path,json.dumps(query),{'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Squali-Route-Acceptance/1'});r=connection.getresponse();body=r.read(1024*1024+1);attempt.update(status=r.status,clientMs=round((time.monotonic()-start)*1000,3),ended=time.time());assert len(body)<=1024*1024
   step={'name':name,'status':r.status,'tier':r.getheader('x-squali-tier'),'cache':r.getheader('x-squali-cache'),'clientMs':attempt['clientMs']};assert r.status==200 and step['tier']=='regional',step
   if query['op']=='head':assert json.loads(body)['head']==s['base']
   else:
    assert body==expected['content'].encode();assert r.getheader('x-squali-oid')==expected['oid'];assert hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body).hexdigest()==expected['oid']
    if name=='new-hit':assert step['cache']=='hit'
   s['operations'][key].update(complete=True,body=step);steps.append(step);save()
  except Exception as error:attempt.update(error=type(error).__name__,ended=time.time(),clientMs=round((time.monotonic()-start)*1000,3));save();raise
 s['phases']['routing']={'complete':True,'deployment':s['phases']['after']['deployment'],'command':shlex.join(['python3',*sys.argv]),'httpAttempts':4,'steps':steps,'automaticRetries':0};save();print(json.dumps(s['phases']['routing']))
finally:connection.close()

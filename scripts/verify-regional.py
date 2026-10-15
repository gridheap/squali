#!/usr/bin/env python3
"""Bounded production read check using an existing credential and retained fixture."""
import argparse,hashlib,json,pathlib,shlex,sys,time,urllib.request,urllib.error

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--access',required=True);p.add_argument('--fixture',required=True);p.add_argument('--output',required=True)
p.add_argument('--principal',choices=['reader','owner'],default='reader');p.add_argument('--prior-report')
a=p.parse_args();target=pathlib.Path(a.output)
if target.exists():
 saved=json.loads(target.read_text())
 if saved.get('complete'):print(json.dumps(saved));sys.exit(0)
 raise SystemExit('A previous attempt exists. Inspect it before explicitly authorizing another live run.')
token=json.loads(pathlib.Path(a.access).read_text())[a.principal];fixture=json.loads(pathlib.Path(a.fixture).read_text())['steps']
project=fixture['project']['id'];oid=fixture['file']['oid'];expected=hashlib.sha256(fixture['file']['content'].encode()).hexdigest()
prior=json.loads(pathlib.Path(a.prior_report).read_text()) if a.prior_report else {}
if prior.get('complete'):raise SystemExit('Reuse the completed verification instead of repeating it')
attempts=prior.get('httpAttempts',0)
report={'command':shlex.join(['python3',*sys.argv]),'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'httpAttempts':attempts,'priorDeniedAttempts':attempts,'maxAttempts':attempts+4,'automaticRetries':0,'steps':[],'complete':False}
def save():target.write_text(json.dumps(report,indent=2)+'\n')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
http=urllib.request.build_opener(NoRedirect())
def call(name,query=None):
 if report['httpAttempts']>=report['maxAttempts']:raise RuntimeError('HTTP attempt ceiling reached')
 report['httpAttempts']+=1;save();started=time.monotonic()
 request=urllib.request.Request('https://squa.li/api/projects/'+project+('/rpc' if query else ''),data=json.dumps(query).encode() if query else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Squali-Regional-Acceptance/1'})
 with http.open(request,timeout=20) as response:
  body=response.read(1024*1024+1)
  if len(body)>1024*1024:raise RuntimeError('Acceptance response exceeds 1 MiB')
  step={'name':name,'status':response.status,'elapsedMs':round((time.monotonic()-started)*1000,2),'tier':response.headers.get('x-squali-tier'),'cache':response.headers.get('x-squali-cache')};report['steps'].append(step);save();return response.headers,body,step
try:
 _,body,_=call('authorization',{'op':'authorize'});lease=json.loads(body);assert lease['project']==project and lease['expiresAt']>time.time()*1000
 for name in ('first-object-read','warm-object-read'):
  headers,body,step=call(name,{'op':'object','oid':oid});assert headers.get('x-squali-tier')=='regional';assert headers.get('x-squali-oid')==oid
  assert hashlib.sha1(('blob '+str(len(body))+'\0').encode()+body).hexdigest()==oid
  assert hashlib.sha256(body).hexdigest()==expected
  if name=='warm-object-read':assert headers.get('x-squali-cache')=='hit'
  step['identityMatchesRetainedFixture']=True;step['bytes']=len(body);save()
 _,body,step=call('project-api');assert json.loads(body)['id']==project;step['projectApiPreserved']=True
 report['complete']=True;save();print(json.dumps(report))
except Exception as error:
 report['failure']={'type':type(error).__name__,'status':getattr(error,'code',None)};save();print(json.dumps(report));sys.exit(1)

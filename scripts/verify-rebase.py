#!/usr/bin/env python3
"""Five-request production rebase-plan check; completed evidence replays offline."""
import argparse,hashlib,json,pathlib,shlex,sys,time,urllib.request
p=argparse.ArgumentParser();p.add_argument('--access',required=True);p.add_argument('--fixture',required=True);p.add_argument('--output',required=True);a=p.parse_args();output=pathlib.Path(a.output)
if output.exists():
 saved=json.loads(output.read_text())
 if saved.get('complete'):print(json.dumps(saved));raise SystemExit(0)
 raise SystemExit('Inspect the retained incomplete attempt; do not silently rerun')
token=json.loads(pathlib.Path(a.access).read_text())['owner'];fixture=json.loads(pathlib.Path(a.fixture).read_text())['steps'];project=fixture['project']['id'];file=fixture['file']
report={'command':shlex.join(['python3',*sys.argv]),'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'httpAttempts':0,'maxAttempts':5,'automaticRetries':0,'complete':False,'steps':[]}
def save():output.write_text(json.dumps(report,indent=2)+'\n')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw):return None
http=urllib.request.build_opener(NoRedirect())
def call(name,path,payload=None):
 assert report['httpAttempts']<5;report['httpAttempts']+=1;save();at=time.monotonic()
 req=urllib.request.Request('https://squa.li/api'+path,data=json.dumps(payload).encode() if payload is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Squali-Rebase-Verification/1'})
 with http.open(req,timeout=30) as r:
  raw=r.read(2*1024**2+1);assert len(raw)<=2*1024**2;value=json.loads(raw);report['steps'].append({'name':name,'status':r.status,'elapsedMs':round((time.monotonic()-at)*1000,2)});save();return value
try:
 before=call('usage-before','/usage');head=call('head-before','/projects/'+project)['head']
 incoming=file['content']+'\nLocal rebase acceptance, not a published edit.\n'
 plan=call('rebase-plan','/projects/'+project+'/rebase-plan',{'base':file['ref'],'onto':file['ref'],'files':[{'path':file['path'],'content':incoming,'mode':file.get('mode','100644')}]})
 assert plan['base']==plan['onto']==file['ref'] and len(plan['files'])==1 and plan['files'][0]['content']==incoming
 assert call('head-after','/projects/'+project)['head']==head
 after=call('usage-after','/usage');assert after['source']['writes']==before['source']['writes']
 report.update(complete=True,exactPlanContent=True,mainUnchanged=True,sourceWritesDelta=0,sourceReadReservationsDelta=after['source']['reads']-before['source']['reads'],usageAfter=after,limitations=['Single production plan observation, not a concurrent or cold-cache benchmark.','Usage reservations can include other callers; provider billing is reconciled separately.']);save();print(json.dumps({k:v for k,v in report.items() if k!='usageAfter'}))
except Exception as error:report['failure']={'type':type(error).__name__,'status':getattr(error,'code',None)};save();print(json.dumps({k:v for k,v in report.items() if k!='usageAfter'}));raise SystemExit(1)

#!/usr/bin/env python3
"""One product-scoped Cloudflare analytics query; no repetition of saved results."""
import argparse,datetime,json,pathlib,shlex,subprocess,sys,urllib.request
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--session',help='Existing private provider-session JSON, never printed');p.add_argument('--prior-report');a=p.parse_args();output=pathlib.Path(a.output)
if output.exists():print('Retained provider measurement: '+str(output));raise SystemExit(0)
journal=output.with_suffix('.request.json')
if journal.exists():raise SystemExit('Inspect the retained request before recovery')
# The token stays in process memory; never emit it, or include it in evidence.
if a.session:value=json.loads(pathlib.Path(a.session).read_text())
else:
 credentials=subprocess.run(['node','node_modules/wrangler/bin/wrangler.js','auth','token','--json'],capture_output=True,text=True,timeout=30,check=True)
 value=json.loads(credentials.stdout)
token=value.get('token')
if not isinstance(token,str) or not token:raise SystemExit('Wrangler returned no usable token')
now=datetime.datetime.now(datetime.timezone.utc);start=now.replace(day=1,hour=0,minute=0,second=0,microsecond=0).isoformat().replace('+00:00','Z');end=now.isoformat().replace('+00:00','Z');span='datetime_geq:'+json.dumps(start)+',datetime_leq:'+json.dumps(end);queries=[]
for i,bucket in enumerate(['squali-source','squali-objects']):
 f='filter:{'+span+',bucketName:'+json.dumps(bucket)+'}'
 queries.append('ops'+str(i)+':r2OperationsAdaptiveGroups(limit:100,'+f+'){sum{requests} dimensions{actionType actionStatus bucketName}}')
 queries.append('storage'+str(i)+':r2StorageAdaptiveGroups(limit:1,'+f+',orderBy:[datetime_DESC]){max{objectCount payloadSize metadataSize} dimensions{datetime bucketName}}')
for alias,worker in [('source','gridheap-weave'),('regional','squali-regional')]:queries.append(alias+':workersInvocationsAdaptive(limit:100,filter:{'+span+',scriptName:'+json.dumps(worker)+'}){sum{requests errors cpuTimeUs subrequests} dimensions{status}}')
queries.append('artifactsEventsAdaptiveGroups(limit:100,filter:{'+span+',repositoryNamespace:"weave"}){count dimensions{eventKind eventType}}')
q='{viewer{accounts(filter:{accountTag:"52f8a24263418828b635c91b6eb06a83"}){'+''.join(queries)+'}}}'
prior=json.loads(pathlib.Path(a.prior_report).read_text()) if a.prior_report else {}
if prior and (not prior.get('failure') or prior.get('attempts',0)>=2):raise SystemExit('Only one recovery of a diagnosed failed query is admitted')
report={'command':shlex.join(['python3',*sys.argv]),'start':start,'end':end,'query':q,'attempts':prior.get('attempts',0)+1,'priorDeniedAttempts':prior.get('attempts',0),'maxAttempts':2,'automaticRetries':0};journal.write_text(json.dumps(report,indent=2)+'\n')
req=urllib.request.Request('https://api.cloudflare.com/client/v4/graphql',data=json.dumps({'query':q}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(req,timeout=45) as r:report['result']=json.load(r)
except Exception as error:
 report['failure']={'type':type(error).__name__,'status':getattr(error,'code',None)};output.write_text(json.dumps(report,indent=2)+'\n');raise SystemExit('Provider request failed; evidence retained without automatic retry')
report['limitations']=['Adaptive provider analytics may lag and may sample.','Month-to-date totals include unrelated Squali requests, prior failures and the existing large import.','R2 data are operation observations and latest storage, not an invoice; account allowances and billing rounding are unknown.','Service-binding requests are not separately billable requests; source and regional invocation counts must not be blindly added for request-price estimates.']
output.write_text(json.dumps(report,indent=2)+'\n')
if report['result'].get('errors'):raise SystemExit('Provider returned errors; inspect retained evidence')
print('Saved scoped provider CPU, storage and operation evidence: '+str(output))

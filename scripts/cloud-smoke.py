import json,pathlib,urllib.request,urllib.error,datetime,os,subprocess,sys
root=pathlib.Path(os.environ.get('SQUALI_SMOKE_WORK','work/cloud-smoke'));root.mkdir(parents=True,exist_ok=True);private=root;access=json.loads(pathlib.Path(os.environ['SQUALI_ACCESS_FILE']).read_text());base=os.environ.get('SQUALI_URL','https://squa.li');statePath=private/'cloud-smoke-state.json';state=json.loads(statePath.read_text()) if statePath.exists() else {'steps':{},'httpAttempts':0,'started':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def save():statePath.write_text(json.dumps(state,indent=2));statePath.chmod(0o600)
def step(key,path,body=None,role='owner',expected=200):
 if key in state['steps']:return state['steps'][key]['body']
 assert state['httpAttempts']<40,'smoke HTTP attempt cap reached';state['httpAttempts']+=1;save()
 headers={'Content-Type':'application/json'}
 if role:headers['Authorization']='Bearer '+access[role]
 cfg=['url = '+json.dumps(base+'/api'+path),'silent','show-error','max-time = 30','write-out = "\\n%{http_code}"']
 for name,value in headers.items():cfg.append('header = '+json.dumps(name+': '+value))
 if body is not None:cfg.append('data = '+json.dumps(json.dumps(body)))
 result=subprocess.run(['curl','--config','-'],input='\n'.join(cfg),capture_output=True,text=True,timeout=35)
 if result.returncode:raise RuntimeError('HTTP transport failed: curl exit '+str(result.returncode))
 raw,code=result.stdout.rsplit('\n',1);status=int(code);data=json.loads(raw) if raw.startswith('{') else {'message':'Non-JSON provider error'}
 if status!=expected:
  state['failure']={'step':key,'status':status,'body':data};save();raise RuntimeError(json.dumps(state['failure']))
 state['steps'][key]={'status':status,'body':data};state.pop('failure',None);save();print(json.dumps({'step':key,'status':status}),flush=True);return data
try:
 step('auth-required','/projects',role=None,expected=401)
 step('session','/session',role='reviewer')
 before=step('usage-before','/usage')
 assert before['attempts']<250,'live smoke provider reservation ceiling reached'
 project=step('workspace','/projects',{'id':'demo','name':'Weave Cloud Demo','files':[{'path':'README.md','content':'# Weave\n\nIndependent work. Shared direction.\n'},{'path':'src/config.ts','content':'export const retries = 1;\n'}]},expected=201)
 for cid,path,content in [('docs','docs/quickstart.md','# Quickstart\nRead only what you need.\n'),('client','src/client.ts','export const retries = 3;\n')]:
  step(cid,'/projects/demo/changes',{'id':cid,'title':'Add '+cid,'intent':'Bounded cloud integration check','base':project['head'],'context':{'smoke':True,'evidence':{'kind':'integration check, not agent-run CI'}},'files':[{'path':path,'content':content}]},'agent',201)
  step('review-'+cid,'/projects/demo/changes/'+cid+'/review',{'decision':'approved','note':'Reviewed in the bounded integration smoke'},'reviewer')
 plan=step('preview','/projects/demo/preview',{'changes':['docs','client']},'reviewer');assert plan['ready']
 published=step('publish','/projects/demo/publish',{'id':'cloud-smoke-v1','changes':['docs','client'],'expectedHead':plan['head']},'reviewer',201)
 file=step('file','/projects/demo/file?path=src/client.ts&ref='+published['oid'],role='reader');assert file['content']=='export const retries = 3;\n'
 step('scope-denied','/projects/private-project',role='reader',expected=403)
 step('role-denied','/projects/demo/publish',{'id':'forbidden','changes':['docs']},'agent',403)
 if not state.get('gitVerified'):
  env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+access['reader']};dest=root/'cloud-git-checkout'
  r=subprocess.run(['git','clone',base+'/api/projects/demo/git',str(dest)],env=env,capture_output=True,text=True,timeout=40)
  if r.returncode:raise RuntimeError('Authenticated Git clone failed; exit '+str(r.returncode))
  assert (dest/'src/client.ts').read_text()=='export const retries = 3;\n';subprocess.run(['git','-C',str(dest),'fsck','--full'],check=True,capture_output=True);state['gitVerified']=True;save()
 after=step('usage-after','/usage');assert after['attempts']<=250,'provider reservation ceiling exceeded'
 report={'command':'SQUALI_URL='+base+' SQUALI_ACCESS_FILE=<private-access-json> python3 scripts/cloud-smoke.py','started':state['started'],'completed':datetime.datetime.now(datetime.timezone.utc).isoformat(),'url':base,'steps':{key:value['status'] for key,value in state['steps'].items()},'gitCloneAndFsck':True,'httpAttempts':state['httpAttempts'],'applicationReservedCalls':after['attempts']-before['attempts'],'providerReservationCeiling':250,'automaticRetries':0,'reusedSuccessfulSteps':True,'publishedCommit':published['oid'],'providerMeasuredCalls':'Not yet available; application reservations are conservative and not billing counts'}
 (root/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
except Exception as e:print(str(e));sys.exit(1)

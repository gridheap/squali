import json,pathlib,subprocess,sys,datetime,os
root=pathlib.Path('work/placement');root.mkdir(parents=True,exist_ok=True);token=json.loads(pathlib.Path(os.environ['SQUALI_ACCESS_FILE']).read_text())['reader'];phase=sys.argv[1];samples=[]
for i in range(3):
 cfg='\n'.join(['url = "https://squa.li/api/usage"','resolve = "squa.li:443:104.21.48.51"','header = '+json.dumps('Authorization: Bearer '+token),'silent','show-error','max-time = 20','write-out = "\\n%{http_code} %{time_total}"'])
 r=subprocess.run(['curl','--config','-'],input=cfg,text=True,capture_output=True,timeout=25);assert r.returncode==0
 raw,metrics=r.stdout.rsplit('\n',1);status,seconds=metrics.split();assert status=='200';usage=json.loads(raw);assert usage['attempts']<=250
 samples.append({'status':int(status),'seconds':float(seconds),'applicationReservations':usage['attempts']})
report={'phase':phase,'command':'SQUALI_ACCESS_FILE=<private-access-json> python3 scripts/check-placement.py '+phase,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':'https://squa.li/api/usage','requests':3,'mutations':0,'providerCalls':0,'samples':samples,'limitation':'Three sequential HTTP reads from one local network using a public DNS address. Not a load test or statistically robust performance claim.'}
p=root/('placement-'+phase+'.json');p.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

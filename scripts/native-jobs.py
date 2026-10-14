#!/usr/bin/env python3
"""One bounded native importer, coordinated by PostgreSQL. No paid idle HTTP polling."""
import argparse,base64,hashlib,json,os,pathlib,re,secrets,select,shutil,signal,ssl,subprocess,sys,time,urllib.parse,urllib.request
from pg8000.native import Connection
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',required=True);p.add_argument('--once',action='store_true');p.add_argument('--max-jobs',type=int,default=100);p.add_argument('--max-seconds',type=int,default=28800);p.add_argument('--segment-seconds',type=int,default=7200);a=p.parse_args()
if not 1<=a.max_jobs<=1000 or not 1<=a.max_seconds<=86400 or not 1<=a.segment_seconds<=7200:raise SystemExit('Finite runner budgets are required')
os.umask(0o077);root=pathlib.Path(a.root).resolve();root.mkdir(parents=True,exist_ok=True)
origin=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');u=urllib.parse.urlparse(os.environ['SQUALI_WORKER_DATABASE_URL']);schema=os.environ.get('SQUALI_DB_SCHEMA','weave')
if not re.fullmatch('[a-zA-Z_][a-zA-Z0-9_]*',schema):raise SystemExit('Invalid database schema')
testing=os.environ.get('SQUALI_ALLOW_TEST_HTTP')=='1';tls=False if testing and os.environ.get('SQUALI_DB_SSL')=='disable' else ssl.create_default_context()
c=Connection(user=urllib.parse.unquote(u.username),password=urllib.parse.unquote(u.password or ''),host=u.hostname,port=u.port or 5432,database=u.path[1:],ssl_context=tls,timeout=20)
c.run('SET search_path TO '+schema);start=time.monotonic();completed=0;claimed=0;stopping=False

def stop(*_):
 global stopping
 stopping=True
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
def query(sql,**values):
 rows=c.run(sql,**values);names=[col['name'] for col in c.columns] if c.columns else [];return [dict(zip(names,row)) for row in rows]
def transaction(fn):
 c.run('BEGIN')
 try:value=fn();c.run('COMMIT');return value
 except BaseException:c.run('ROLLBACK');raise
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
http=urllib.request.build_opener(NoRedirect())
def credentials(project,token,lease):
 request=urllib.request.Request(origin+'/api/projects/'+project+'/source/credentials',data=json.dumps({'lease':lease}).encode(),headers={'Authorization':'Bearer '+token,'User-Agent':'Squali-Native-Job/1','Content-Type':'application/json'})
 with http.open(request,timeout=30) as r:
  body=r.read(65537)
  if len(body)>65536:raise RuntimeError('Credential response exceeds its limit')
  value=json.loads(body)
 remote=urllib.parse.urlparse(value['remote'])
 if remote.username or remote.password or remote.query or remote.fragment or remote.scheme not in (['https','http'] if testing else ['https']):raise RuntimeError('Invalid Git remote')
 return value

def terminate(child):
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
def usage(path):
 total=0
 for base,_,files in os.walk(path):
  for name in files:
   try:total+=(pathlib.Path(base)/name).stat().st_size
   except FileNotFoundError:pass
 return total

def execute(row,token,lease):
 jobdir=root/row['import_id'];jobdir.mkdir(exist_ok=True);repo=jobdir/'source.git';journal=jobdir/'state';marker=jobdir/'cache.json';job_start=time.monotonic();previous=row['elapsed_seconds'];last_update=0;stage='clone'
 # All cumulative HTTP/byte budgets reside in import-source.py's durable journal.
 def progress():
  nonlocal last_update
  now=time.monotonic();spent=int(now-job_start);saved={}
  if (journal/'state.json').exists():
   s=json.loads((journal/'state.json').read_text());saved={k:s[k] for k in ('stage','objectsProcessed','commitsProcessed','httpAttempts','uploadedBytes','complete','sourceObjects','sourceBytes') if k in s}
  if now-last_update>=15:
   c.run("UPDATE weave_native_jobs SET progress=CAST(:progress AS jsonb),elapsed_seconds=:elapsed,lease_until=now()+interval '2 minutes',updated_at=now() WHERE import_id=:id AND lease=:lease",progress=json.dumps(saved or {'stage':stage}),elapsed=previous+spent,id=row['import_id'],lease=lease);last_update=now
  state=query('SELECT state,pause_requested FROM weave_native_jobs WHERE import_id=:id',id=row['import_id'])[0]
  if state['state']=='complete':return 'complete'
  if stopping or state['pause_requested'] or now-start>=a.max_seconds or previous+spent>=28800:return 'paused'
  return None
 def run(command,env,byte_limit=None):
  # Logs can contain repository names; keep them private and never relay provider errors to the browser.
  with open(jobdir/'process.log','ab',buffering=0) as log:
   child=subprocess.Popen(command,env=env,stdout=log,stderr=log,start_new_session=True)
   try:
    while child.poll() is None:
     state=progress()
     if state=='paused':terminate(child);return 'paused'
     if byte_limit and usage(repo)>byte_limit:terminate(child);raise RuntimeError('Native clone exceeded the 2 GiB disk budget')
     time.sleep(0.25 if testing else 3)
    return child.returncode
   finally:terminate(child)
 if not marker.exists():
  if shutil.disk_usage(root).free<4*1024**3:raise RuntimeError('Insufficient native cache disk space')
  auth=credentials(row['project_id'],token,lease)
  if repo.exists():shutil.rmtree(repo) # Only this explicitly retried, unmarked partial clone.
  environment={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_ALLOW_PROTOCOL':'http:https','GIT_CONFIG_COUNT':'2','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Basic '+base64.b64encode(('x-access-token:'+auth['token']).encode()).decode(),'GIT_CONFIG_KEY_1':'http.followRedirects','GIT_CONFIG_VALUE_1':'false'}
  # Do not pass the database credential to Git or hooks.
  environment.pop('SQUALI_WORKER_DATABASE_URL',None)
  result=run(['git','-c','core.hooksPath=/dev/null','clone','--mirror',auth['remote'],str(repo)],environment,2*1024**3)
  if result=='paused':return 'paused'
  if result!=0:raise RuntimeError('Native Git clone failed; inspect the private runner log')
  if usage(repo)>2*1024**3:raise RuntimeError('Native clone exceeded the 2 GiB disk budget')
  marker.write_text(json.dumps({'repository':row['repository_id'],'project':row['project_id']}));auth=None;environment=None
 elif json.loads(marker.read_text())!={'repository':row['repository_id'],'project':row['project_id']}:raise RuntimeError('Native cache identity mismatch')
 stage='objects';environment={**os.environ,'SQUALI_TOKEN':token,'SQUALI_URL':origin,'SQUALI_JOB_LEASE':lease};environment.pop('SQUALI_WORKER_DATABASE_URL',None)
 for segment in range(32):
  if progress()=='paused':return 'paused'
  remaining=max(1,min(a.segment_seconds,a.max_seconds-int(time.monotonic()-start),28800-previous-int(time.monotonic()-job_start)))
  checkpoint=journal/'state.json';before=checkpoint.read_bytes() if checkpoint.exists() else None
  result=run([sys.executable,str(pathlib.Path(__file__).with_name('import-source.py')),row['project_id'],str(repo),'--state',str(journal),'--max-batches','10000','--max-seconds',str(remaining)],environment)
  status=progress()
  if status=='complete':return 'complete'
  if result=='paused' or status=='paused':return 'paused'
  if result==2:
   # A successful checkpoint continues the same job and cumulative journal budget.
   # Errors, exhausted budgets and stalled cursors never trigger an automatic retry.
   if not checkpoint.exists() or checkpoint.read_bytes()==before:return 'paused'
   continue
  if result!=0:raise RuntimeError('Source ingestion stopped; retain the journal and inspect the private runner log')
  raise RuntimeError('Source finish did not confirm all refs')
 return 'paused'

try:
 if not c.run("SELECT pg_try_advisory_lock(hashtextextended('squali-native-runner',0))")[0][0]:raise SystemExit('Another native runner already holds the capacity lock')
 # After process death, held leases never silently retry. The owner must explicitly resume.
 c.run("UPDATE weave_native_jobs SET state=CASE WHEN pause_requested THEN 'paused' ELSE 'failed' END,updated_at=now() WHERE state='running'")
 c.run("UPDATE weave_github_imports i SET state=j.state,error='Native runner stopped; resume from the retained journal',updated_at=now() FROM weave_native_jobs j WHERE j.import_id=i.id AND j.state IN ('failed','paused') AND i.state IN ('running','pausing')")
 c.run("UPDATE weave_tokens SET revoked_at=now() WHERE id IN (SELECT token_id FROM weave_native_jobs WHERE state<>'running') AND revoked_at IS NULL")
 c.run('LISTEN squali_native_jobs')
 while not stopping and claimed<a.max_jobs and time.monotonic()-start<a.max_seconds:
  token='sq_'+secrets.token_urlsafe(32);token_id='job_'+secrets.token_hex(12);lease=secrets.token_hex(24)
  def claim():
   rows=query("SELECT j.*,i.project_id,i.repository_id,i.native_attempts FROM weave_native_jobs j JOIN weave_github_imports i ON i.id=j.import_id WHERE j.state='queued' AND NOT j.pause_requested AND i.native_attempts<3 AND j.elapsed_seconds<28800 ORDER BY j.updated_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED")
   if not rows:return None
   row=rows[0];c.run("INSERT INTO weave_tokens(id,project,token_hash,label,role,expires_at) VALUES(:id,:project,:hash,'Native import job','admin',now()+interval '8 hours')",id=token_id,project=row['project_id'],hash=hashlib.sha256(token.encode()).hexdigest())
   c.run("UPDATE weave_native_jobs SET state='running',lease=:lease,lease_until=now()+interval '2 minutes',token_id=:token,updated_at=now() WHERE import_id=:id",lease=lease,token=token_id,id=row['import_id'])
   c.run("UPDATE weave_github_imports SET state='running',native_attempts=native_attempts+1,error=NULL,updated_at=now() WHERE id=:id",id=row['import_id']);return row
  row=transaction(claim)
  if row is None:
   if a.once:break
   # pg8000's socket is isolated here; SELECT drains notifications after readiness or a 30 s reconciliation.
   select.select([c._usock],[],[],min(30,max(0,a.max_seconds-(time.monotonic()-start))));c.run('SELECT 1');c.notifications.clear();continue
  claimed+=1;outcome='failed';error=None
  try:outcome=execute(row,token,lease)
  except Exception as e:error=str(e) if isinstance(e,RuntimeError) else 'Native job interrupted ('+type(e).__name__+')'
  finally:
   # Source finish can commit just before a lost acknowledgement. Its durable result wins.
   current=query('SELECT state,pause_requested FROM weave_native_jobs WHERE import_id=:id',id=row['import_id'])[0]
   if current['state']=='complete':outcome='complete';completed+=1
   elif current['pause_requested']:outcome='paused'
   c.run("UPDATE weave_native_jobs SET state=:state,lease_until=NULL,updated_at=now() WHERE import_id=:id",state=outcome,id=row['import_id'])
   c.run("UPDATE weave_github_imports SET state=:state,error=:error,updated_at=now() WHERE id=:id AND state<>'complete'",state=outcome,error=error,id=row['import_id'])
   c.run('UPDATE weave_tokens SET revoked_at=now() WHERE id=:id',id=token_id)
  if a.once:break
 print(json.dumps({'claimed':claimed,'completed':completed,'seconds':round(time.monotonic()-start,2)}))
finally:c.close()

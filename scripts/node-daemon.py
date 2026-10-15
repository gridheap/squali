#!/usr/bin/env python3
"""Private Unix-socket relay for Squali's source RPC; bounded verified SQLite cache."""
import argparse,hashlib,json,os,pathlib,re,signal,socketserver,sqlite3,struct,threading,time,urllib.request,urllib.error
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--socket',required=True);p.add_argument('--cache',required=True);p.add_argument('--max-bytes',type=int,default=1024**3);p.add_argument('--restore');a=p.parse_args()
if not 1024**2<=a.max_bytes<=16*1024**3:raise SystemExit('Cache cap must be 1 MiB–16 GiB')
base=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN')
if not token:raise SystemExit('Set SQUALI_TOKEN')
namespace=hashlib.sha256((base+'\0'+token).encode()).hexdigest();root=pathlib.Path(a.cache);root.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(root,0o700)
path=root/'objects.sqlite';lock=threading.RLock();flights={};errors={};leases={};stats={'originObjects':0,'originBlobs':0,'hits':0,'coalesced':0,'networkBytes':0,'failures':0}
class Fault(Exception):
 def __init__(self,status,body):self.status=status;self.body=body
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
http=urllib.request.build_opener(NoRedirect())
def verify(query,headers,body):
 if query.get('op')=='object':
  kind=headers.get('x-squali-type');oid=headers.get('x-squali-oid')
  if kind not in ('blob','tree','commit','tag') or oid!=query.get('oid') or hashlib.sha1((kind+' '+str(len(body))+'\0').encode()+body).hexdigest()!=oid:raise Fault(502,b'Object identity mismatch')
 elif query.get('op')=='stat':
  values=json.loads(body)['objects']
  if {v['oid'] for v in values}!=set(query['oids']) or any(v['type'] not in ('blob','tree','commit','tag') or not isinstance(v['size'],int) or v['size']<0 for v in values):raise Fault(502,b'Invalid object metadata')
def restore(source):
 source=pathlib.Path(source);manifest=json.loads(source.with_suffix('.json').read_text())
 if manifest['namespace']!=namespace or source.stat().st_size>a.max_bytes+4*1024**2 or hashlib.sha256(source.read_bytes()).hexdigest()!=manifest['sha256']:raise SystemExit('Snapshot identity, size or checksum mismatch')
 source_db=sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)
 if source_db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise SystemExit('Snapshot database is corrupt')
 total=0
 for query,headers,body,digest in source_db.execute('SELECT query,headers,body,digest FROM entries'):
  total+=len(body)
  if hashlib.sha256(body).hexdigest()!=digest:raise SystemExit('Snapshot entry is corrupt')
  verify(json.loads(query),json.loads(headers),body)
 if total>a.max_bytes:raise SystemExit('Snapshot exceeds cache budget')
 destination=sqlite3.connect(path);source_db.backup(destination);destination.close();source_db.close()
if a.restore:
 if path.exists():raise SystemExit('Restore requires a new empty cache directory')
 restore(a.restore)
db=sqlite3.connect(path,check_same_thread=False);os.chmod(path,0o600);db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA journal_size_limit=1048576');db.execute('CREATE TABLE IF NOT EXISTS entries(key TEXT PRIMARY KEY,namespace TEXT,query TEXT,headers TEXT,body BLOB,digest TEXT,used REAL)');db.execute('CREATE INDEX IF NOT EXISTS cache_used ON entries(used)');db.commit()
cached_bytes=db.execute('SELECT COALESCE(sum(length(body)),0) FROM entries').fetchone()[0]
def upstream(project,query=None):
 url=base+'/api/projects/'+project+('/rpc' if query is not None else '')
 request=urllib.request.Request(url,data=json.dumps(query,separators=(',',':')).encode() if query is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'Squali-Node/1'})
 try:
  with http.open(request,timeout=20) as response:
   body=response.read(33*1024**2+1);headers={k.lower():v for k,v in response.headers.items() if k.lower() in ('content-type','x-squali-type','x-squali-oid')}
   if len(body)>33*1024**2:raise Fault(413,b'RPC response exceeds the node limit')
   return headers,body
 except urllib.error.HTTPError as error:raise Fault(error.code,error.read(65536)) from None
 except (urllib.error.URLError,TimeoutError,OSError):raise Fault(503,b'Authority unavailable; no bypass or automatic retry') from None

def authorize(project):
 # One lock also coalesces authorization refreshes. A failed refresh cannot serve stale authorization.
 with lock:
  now=time.monotonic();lease=leases.get(project)
  if len(leases)>=1024 and not lease:leases.pop(next(iter(leases)))
  if lease and lease[0]>now:
   if lease[1]:raise lease[1]
   return
  try:
   _,body=upstream(project,{'op':'authorize'});lease=json.loads(body)
   if lease.get('project')!=project or not isinstance(lease.get('expiresAt'),(int,float)):raise Fault(502,b'Invalid authorization lease')
   remaining=min(30,lease['expiresAt']/1000-time.time())
   if remaining<=0:raise Fault(401,b'Authorization lease expired')
   # Preserve the authority's deadline across tiers; do not add another 30s.
   leases[project]=(time.monotonic()+remaining,None)
  except Fault as error:leases[project]=(now+10,error);raise

def fetch(project,query):
 global cached_bytes
 if query.get('op')=='stat':query={**query,'oids':sorted(set(query['oids']))}
 authorize(project)
 if query['op']=='head':return upstream(project,query)
 canonical=json.dumps(query,sort_keys=True,separators=(',',':'));key=hashlib.sha256((namespace+'\0'+project+'\0'+canonical).encode()).hexdigest()
 while True:
  with lock:
   row=db.execute('SELECT headers,body,digest FROM entries WHERE key=? AND namespace=?',(key,namespace)).fetchone()
   if row:
    headers,body,digest=row
    if hashlib.sha256(body).hexdigest()!=digest:raise Fault(503,b'Local cache is corrupt; no automatic bypass')
    verify(query,json.loads(headers),body);stats['hits']+=1;db.execute('UPDATE entries SET used=? WHERE key=?',(time.time(),key));db.commit();return json.loads(headers),body
   failure=errors.get(key)
   if failure and failure[0]>time.monotonic():raise failure[1]
   event=flights.get(key)
   if not event:event=threading.Event();flights[key]=event;break
   stats['coalesced']+=1
  if not event.wait(25):raise Fault(503,b'Node request is still in progress')
 try:
  with lock:stats['originObjects']+=1
  headers,body=upstream(project,query);verify(query,headers,body)
  with lock:
   stats['networkBytes']+=len(body)
   if headers.get('x-squali-type')=='blob':stats['originBlobs']+=1
   if len(body)<=a.max_bytes:
    size=cached_bytes
    while size+len(body)>a.max_bytes:
     oldest=db.execute('SELECT key,length(body) FROM entries ORDER BY used LIMIT 1').fetchone()
     if not oldest:break
     db.execute('DELETE FROM entries WHERE key=?',(oldest[0],));size-=oldest[1]
    db.execute('INSERT OR REPLACE INTO entries VALUES(?,?,?,?,?,?,?)',(key,namespace,canonical,json.dumps(headers),body,hashlib.sha256(body).hexdigest(),time.time()));db.commit();cached_bytes=size+len(body)
  return headers,body
 except Fault as error:
  with lock:
   stats['failures']+=1
   if len(errors)>=4096:errors.pop(next(iter(errors)))
   errors[key]=(time.monotonic()+10,error)
  raise
 finally:
  with lock:flights.pop(key).set()

def snapshot(name):
 if not isinstance(name,str) or not re.fullmatch('[a-zA-Z0-9_-]{1,48}',name):raise Fault(400,b'Invalid snapshot name')
 folder=root/'snapshots';folder.mkdir(mode=0o700,exist_ok=True);target=folder/(name+'.sqlite');temp=folder/(name+'.tmp')
 with lock:
  db.commit();output=sqlite3.connect(temp);db.backup(output);output.close();os.chmod(temp,0o600);os.replace(temp,target)
 manifest={'version':1,'namespace':namespace,'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'created':time.time()}
 meta=target.with_suffix('.json');meta.write_text(json.dumps(manifest));os.chmod(meta,0o600)
 return {'path':str(target.resolve()),'bytes':manifest['bytes'],'sha256':manifest['sha256']}

def exact(stream,n):
 result=b''
 while len(result)<n:
  part=stream.read(n-len(result))
  if not part:raise EOFError()
  result+=part
 return result
class Handler(socketserver.StreamRequestHandler):
 def handle(self):
  self.connection.settimeout(30)
  try:
   n=struct.unpack('!I',exact(self.rfile,4))[0]
   if n>128*1024:raise Fault(413,b'Node request is too large')
   query=json.loads(exact(self.rfile,n));op=query.get('op');headers={'content-type':'application/json'}
   if op=='stats':
    with lock:body=json.dumps(stats|{'cachedBytes':db.execute('SELECT COALESCE(sum(length(body)),0) FROM entries').fetchone()[0]}).encode()
   elif op=='snapshot':body=json.dumps(snapshot(query.get('name'))).encode()
   else:
    project=query.pop('project',None)
    if not isinstance(project,str) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',project) or op not in ('head','object','stat'):raise Fault(400,b'Invalid project or operation')
    if op=='object' and not re.fullmatch('[a-f0-9]{40}',str(query.get('oid',''))):raise Fault(400,b'Use an immutable object ID')
    if op=='stat' and (not isinstance(query.get('oids'),list) or not 1<=len(query['oids'])<=2000 or any(not re.fullmatch('[a-f0-9]{40}',str(v)) for v in query['oids'])):raise Fault(400,b'Invalid stat batch')
    headers,body=fetch(project,query)
   status=200
  except Fault as error:status=error.status;headers={'content-type':'text/plain'};body=error.body
  except (ValueError,KeyError,TypeError,EOFError):status=400;headers={};body=b'Malformed node request'
  except Exception:status=503;headers={};body=b'Node cache failure; no direct authority fallback'
  meta=json.dumps({'status':status,'headers':headers,'length':len(body)}).encode()
  try:self.wfile.write(struct.pack('!I',len(meta))+meta+body)
  except (BrokenPipeError,ConnectionResetError):pass
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
 daemon_threads=True;request_queue_size=32
 def __init__(self,*args):self.slots=threading.BoundedSemaphore(32);super().__init__(*args)
 def process_request(self,request,address):
  if not self.slots.acquire(False):request.close();return
  try:super().process_request(request,address)
  except Exception:self.slots.release();raise
 def process_request_thread(self,request,address):
  try:super().process_request_thread(request,address)
  finally:self.slots.release()
def terminate(*_):raise SystemExit(0)
signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
server=Server(a.socket,Handler);os.chmod(a.socket,0o600)
print(json.dumps({'ready':True,'socket':a.socket,'cacheCap':a.max_bytes}),flush=True)
try:server.serve_forever(poll_interval=0.1)
finally:server.server_close();pathlib.Path(a.socket).unlink(missing_ok=True)

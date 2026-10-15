#!/usr/bin/env python3
"""Linux on-demand working copy: immutable FUSE lower, bounded durable OverlayFS upper."""
import argparse,fcntl,hashlib,json,os,pathlib,re,select,shutil,signal,socket,stat,struct,subprocess,sys,tempfile,urllib.request

def main():
 argv=sys.argv[1:];at=argv.index('--') if '--' in argv else len(argv);command=argv[at+1:];argv=argv[:at]
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('action',choices=['run','status','propose']);p.add_argument('--state',required=True);p.add_argument('--socket',required=True)
 p.add_argument('--project');p.add_argument('--ref');p.add_argument('--max-bytes',type=int,default=256*1024**2)
 p.add_argument('--seconds',type=int,default=900,help='Command lifetime, 1–3,600 seconds')
 p.add_argument('--id');p.add_argument('--title');p.add_argument('--isolated',action='store_true',help=argparse.SUPPRESS)
 a=p.parse_args(argv)
 if not 1<=a.seconds<=3600:raise ValueError('Command lifetime must be 1–3,600 seconds')
 if sys.platform!='linux' or os.geteuid()!=0:raise ValueError('Use a Linux node with mount capability; run in its private mount namespace as root')
 if not a.isolated:
  os.execvp('unshare',['unshare','--mount','--pid','--mount-proc','--fork','--kill-child','--',sys.executable,str(pathlib.Path(__file__).resolve()),'--isolated',*sys.argv[1:]])
 if os.getpid()!=1:raise ValueError('A private process namespace is required')
 # If this namespace's init dies, Linux kills every remaining descendant and
 # releases their mounts, including processes that detached from our group.
 def interrupted(number,_frame):raise SystemExit(128+number)
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
 checked(['mount','--make-rprivate','/'])
 state=pathlib.Path(a.state).resolve();state.mkdir(mode=0o700,parents=True,exist_ok=True)
 if state.stat().st_uid!=os.geteuid() or state.stat().st_mode&0o077:raise ValueError('State directory must be private and owned by the mounting user')
 with open(state/'lock','a') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise ValueError('This workspace is already mounted or being submitted') from None
  manifest_path=state/'manifest.json';manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else None
  if manifest is None:
   if a.action!='run' or not a.project or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.project):raise ValueError('Initialize with run --project PROJECT --ref IMMUTABLE_COMMIT')
   if not re.fullmatch('[a-f0-9]{40}',a.ref or '') or not 32*1024**2<=a.max_bytes<=1024**3:raise ValueError('Supply an immutable commit and an overlay cap of 32 MiB–1 GiB')
   manifest={'version':1,'project':a.project,'ref':a.ref,'maxBytes':a.max_bytes,'origin':os.environ.get('SQUALI_URL','https://squa.li').rstrip('/')}
   image=state/'overlay.ext4'
   if image.exists():raise ValueError('Unfinished initialization; preserve this state and choose another directory')
   with open(image,'xb') as f:f.truncate(a.max_bytes)
   checked(['mkfs.ext4','-q','-F',str(image)]);atomic_json(manifest_path,manifest)
  if manifest['version']!=1 or a.ref and a.ref!=manifest['ref'] or a.project and a.project!=manifest['project']:raise ValueError('The workspace is pinned to its original project and commit; choose a new state directory')
  if a.action=='propose':
   if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.id or '') or not a.title or not a.title.strip() or len(a.title)>200:raise ValueError('Supply --id and a nonblank --title of at most 200 characters')
   receipt=state/('receipt-'+a.id+'.json')
   if receipt.exists():
    saved=json.loads(receipt.read_text())
    if saved['title']!=a.title:raise ValueError('This operation ID already has another title')
    print(json.dumps(saved['response']));return
  root=pathlib.Path(tempfile.mkdtemp(prefix='squali-workspace-'));mounted=[];fuse=None
  try:
   disk=root/'disk';disk.mkdir();checked(['mount','-t','ext4','-o','loop,nosuid,nodev',str(state/'overlay.ext4'),str(disk)]);mounted.append(disk)
   upper=disk/'upper';work=disk/'work';upper.mkdir(exist_ok=True);work.mkdir(exist_ok=True)
   if a.action=='run':
    if not command:raise ValueError('Supply a command after --')
    lower=root/'lower';view=root/'view';lower.mkdir();view.mkdir()
    fuse=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).with_name('squali-fuse.py')),'--socket',a.socket,'--project',manifest['project'],'--ref',manifest['ref'],'--mount',str(lower)],stdout=subprocess.PIPE,text=True)
    if not select.select([fuse.stdout],[],[],30)[0] or not fuse.stdout.readline():raise ValueError('Source filesystem did not start')
    mounted.append(lower)
    checked(['mount','-t','overlay','overlay','-o',f'lowerdir={lower},upperdir={upper},workdir={work},index=off,metacopy=off,redirect_dir=off,nosuid,nodev',str(view)]);mounted.append(view)
    child=subprocess.Popen(command,cwd=view,start_new_session=True)
    try:code=child.wait(timeout=a.seconds)
    finally:
     # A shell can exit while a background process still holds its working
     # directory. Stop that command group before unmounting the persistent disk.
     try:os.killpg(child.pid,signal.SIGKILL)
     except ProcessLookupError:pass
     child.wait(timeout=5)
    if code:raise ValueError('Working-copy command failed with exit '+str(code))
   else:
    pending=state/('pending-'+str(a.id)+'.json')
    if a.action=='propose' and pending.exists():
     payload=json.loads(pending.read_text())
     if payload['title']!=a.title:raise ValueError('Resume the saved proposal with its original title')
    else:
     files=changes(upper,manifest,a.socket)
     if a.action=='status':print(json.dumps({'base':manifest['ref'],'changes':[{'path':f['path'],'deleted':f['content'] is None,'mode':f.get('mode')} for f in files]}));return
     if not files:raise ValueError('No source changes to propose')
     payload={'id':a.id,'title':a.title,'intent':a.title,'base':manifest['ref'],'files':files};atomic_json(pending,payload)
    base=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN')
    if base!=manifest['origin'] or not token:raise ValueError('Set the original SQUALI_URL and a current SQUALI_TOKEN')
    request=urllib.request.Request(base+'/api/projects/'+manifest['project']+'/changes',data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
     def redirect_request(self,*args,**kwargs):return None
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=30) as response:value=json.loads(response.read(2*1024**2))
    if not re.fullmatch('[a-f0-9]{40}',str(value.get('oid',''))):raise ValueError('Server did not confirm a durable changeset; retry the same ID')
    atomic_json(receipt,{'title':a.title,'response':value});pending.unlink();print(json.dumps(value))
  finally:
   cleanup=[]
   for mount in reversed(mounted):
    if subprocess.run(['umount',str(mount)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15).returncode:cleanup.append(str(mount))
   if fuse:
    fuse.terminate()
    try:fuse.wait(timeout=5)
    except subprocess.TimeoutExpired:fuse.kill();fuse.wait()
   # Never recursively remove a directory if it might still be mounted: that
   # would delete the user's upper layer. Namespace teardown releases mounts.
   if cleanup:raise ValueError('Unmount incomplete; state preserved. Temporary mount directories: '+', '.join(cleanup))
   shutil.rmtree(root)

def checked(args):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30)
 if r.returncode:raise ValueError(r.stderr.strip() or 'Command failed: '+args[0])

def atomic_json(path,value):
 temp=path.with_suffix('.tmp')
 with open(temp,'w') as f:os.chmod(temp,0o600);json.dump(value,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
 os.replace(temp,path)
 fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)

def rpc(sock,project,**query):
 def exact(s,n):
  parts=[]
  while n:
   part=s.recv(n)
   if not part:raise ValueError('Node response ended')
   parts.append(part);n-=len(part)
  return b''.join(parts)
 with socket.socket(socket.AF_UNIX) as s:
  s.settimeout(25);s.connect(sock);body=json.dumps({'project':project,**query}).encode();s.sendall(struct.pack('!I',len(body))+body)
  size=struct.unpack('!I',exact(s,4))[0]
  if size>65536:raise ValueError('Invalid node frame')
  meta=json.loads(exact(s,size))
  if not 0<=meta['length']<=33*1024**2:raise ValueError('Invalid node body size')
  data=exact(s,meta['length'])
  if meta['status']!=200:raise ValueError('Node rejected source read: '+str(meta['status']))
  return data

def changes(upper,manifest,sock):
 project=manifest['project'];raw=rpc(sock,project,op='object',oid=manifest['ref']);tree=next(line[5:].decode() for line in raw.splitlines() if line.startswith(b'tree '))
 trees={};result={};inspected=0;total=0
 def safe(path):
  if len(path)>512 or '\\' in path or any(x in ('','.','..','.git') for x in path.split('/')) or any(ord(c)<32 or ord(c)==127 for c in path):raise ValueError('Unsupported source path')
 def entries(oid):
  if oid not in trees:
   if len(trees)>=4096:raise ValueError('Metadata tree budget exhausted')
   data=rpc(sock,project,op='object',oid=oid);at=0;items={}
   while at<len(data):
    space=data.index(b' ',at);nul=data.index(b'\0',space);mode=int(data[at:space],8);name=data[space+1:nul].decode();items[name]=(mode,data[nul+1:nul+21].hex());at=nul+21
   trees[oid]=items
  return trees[oid]
 def original(path):
  current=(stat.S_IFDIR,tree)
  for name in path.split('/'):
   if not current or not stat.S_ISDIR(current[0]):return None
   current=entries(current[1]).get(name)
  return current
 def put(path,content,mode=None):
  nonlocal total
  safe(path)
  if len(result)>=64 and path not in result:raise ValueError('A proposal accepts at most 64 changed files')
  if content is not None:
   total+=len(content.encode())
   if total>1024**2:raise ValueError('Proposal content exceeds 1 MiB')
  result[path]={'path':path,'content':content,**({'mode':mode} if mode else {})}
 def remove(path,entry):
  nonlocal inspected
  if not entry:return
  inspected+=1
  if inspected>10000:raise ValueError('Changed-path metadata budget exhausted')
  if stat.S_ISDIR(entry[0]):
   for name,child in entries(entry[1]).items():remove(path+'/'+name,child)
  elif stat.S_ISREG(entry[0]):put(path,None)
  else:raise ValueError('Symlinks and submodules require explicit native handling')
 def xattr(path,name):
  try:return os.getxattr(path,name,follow_symlinks=False)
  except OSError:return None
 def walk(directory,prefix=''):
  nonlocal inspected
  for path in sorted(directory.iterdir()):
   inspected+=1
   if inspected>10000:raise ValueError('Changed-path metadata budget exhausted')
   relative=prefix+path.name;safe(relative);info=path.lstat();before=original(relative)
   if stat.S_ISCHR(info.st_mode) and info.st_rdev==0 or xattr(path,'trusted.overlay.whiteout') is not None:remove(relative,before)
   elif stat.S_ISDIR(info.st_mode):
    if before and not stat.S_ISDIR(before[0]):raise ValueError('File/directory replacement needs an explicit source operation')
    if xattr(path,'trusted.overlay.opaque')==b'y':remove(relative,before)
    walk(path,relative+'/')
   elif stat.S_ISREG(info.st_mode):
    if before and not stat.S_ISREG(before[0]):raise ValueError('Unsupported source type replacement')
    if info.st_size>256*1024:raise ValueError('Edited files are limited to 256 KiB')
    body=path.read_bytes();mode='100755' if info.st_mode&0o111 else '100644';oid=hashlib.sha1(('blob '+str(len(body))+'\0').encode()+body).hexdigest()
    if before and before[1]==oid and mode==('100755' if before[0]&0o111 else '100644'):
     # An opaque replacement directory first marks old descendants deleted.
     # A recreated identical file cancels that deletion without sending a blob.
     result.pop(relative,None);continue
    if b'\0' in body:raise ValueError('Only UTF-8 text edits are supported')
    put(relative,body.decode('utf-8'),mode)
   else:raise ValueError('Only regular source-file edits are supported')
 walk(upper)
 return [result[path] for path in sorted(result)]

if __name__=='__main__':
 try:main()
 except (ValueError,OSError,subprocess.SubprocessError) as error:print(str(error),file=sys.stderr);sys.exit(2)

#!/usr/bin/env python3
"""Linux on-demand working copy: immutable FUSE lower, bounded durable OverlayFS upper."""
import argparse,fcntl,hashlib,json,os,pathlib,re,select,shutil,signal,socket,stat,struct,subprocess,sys,tempfile,urllib.request

def main():
 argv=sys.argv[1:];at=argv.index('--') if '--' in argv else len(argv);command=argv[at+1:];argv=argv[:at]
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('action',choices=['run','status','propose','rebase','abort-rebase']);p.add_argument('--state',required=True);p.add_argument('--socket',required=True)
 p.add_argument('--project');p.add_argument('--ref');p.add_argument('--max-bytes',type=int,default=256*1024**2)
 p.add_argument('--seconds',type=int,default=900,help='Command lifetime, 1–3,600 seconds')
 p.add_argument('--id');p.add_argument('--title');p.add_argument('--isolated',action='store_true',help=argparse.SUPPRESS)
 p.add_argument('--onto');p.add_argument('--resolutions',help='JSON array of explicit conflict resolutions')
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
  if manifest['version']!=1 or a.ref and a.ref!=manifest['ref'] or a.project and a.project!=manifest['project']:raise ValueError('The workspace is pinned to its current project and commit; use rebase to change the base')
  journal_path=state/'rebase.json';journal=json.loads(journal_path.read_text()) if journal_path.exists() else None
  if journal and manifest.get('lastRebase')==journal['id']:
   finish_rebase(state,journal);journal=None
  if journal:
   receipt=state/('rebase-receipt-'+journal['id']+'.json')
   if receipt.exists() and json.loads(receipt.read_text())['response']['status']=='aborted':
    (state/journal['image']).unlink(missing_ok=True);journal_path.unlink();sync_dir(state);journal=None
  if a.action in ('rebase','abort-rebase'):
   if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.id or ''):raise ValueError('Supply an operation --id')
   receipt=state/('rebase-receipt-'+a.id+'.json')
   if receipt.exists():
    saved=json.loads(receipt.read_text())
    if a.onto and saved['onto']!=a.onto:raise ValueError('This rebase ID already has another target')
    if a.resolutions and read_resolutions(a.resolutions)!=saved.get('resolutions',[]):raise ValueError('This rebase ID already has another resolution')
    print(json.dumps(saved['response']));return
   if journal and (journal['id']!=a.id or a.onto and journal['onto']!=a.onto):raise ValueError('Resume or abort the pending rebase with its original ID and target')
   if a.action=='abort-rebase':
    if not journal:raise ValueError('No pending rebase')
    (state/journal['image']).unlink(missing_ok=True)
    atomic_json(receipt,{'onto':journal['onto'],'response':{'id':a.id,'status':'aborted','base':manifest['ref']}})
    journal_path.unlink();sync_dir(state);print(json.dumps({'id':a.id,'status':'aborted','base':manifest['ref']}));return
   if not re.fullmatch('[a-f0-9]{40}',a.onto or ''):raise ValueError('Supply --onto IMMUTABLE_COMMIT')
   if any(state.glob('pending-*.json')):raise ValueError('Resolve pending proposals before rebasing')
  elif journal and a.action!='status':raise ValueError('A rebase is pending; resume or abort it before editing or proposing')
  if a.action=='propose':
   if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}',a.id or '') or not a.title or not a.title.strip() or len(a.title)>200:raise ValueError('Supply --id and a nonblank --title of at most 200 characters')
   receipt=state/('receipt-'+a.id+'.json')
   if receipt.exists():
    saved=json.loads(receipt.read_text())
    if saved['title']!=a.title:raise ValueError('This operation ID already has another title')
    print(json.dumps(saved['response']));return
  root=pathlib.Path(tempfile.mkdtemp(prefix='squali-workspace-'));mounted=[];fuse=None
  try:
   disk=root/'disk';disk.mkdir();checked(['mount','-t','ext4','-o','loop,nosuid,nodev',str(state/manifest.get('image','overlay.ext4')),str(disk)]);mounted.append(disk)
   upper=disk/'upper';work=disk/'work';upper.mkdir(exist_ok=True);work.mkdir(exist_ok=True)
   if a.action=='rebase':
    rebase_workspace(a,state,manifest,journal,upper,root,mounted);return
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
    value=api(manifest,'changes',payload)
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
 sync_dir(path.parent)

def sync_dir(path):
 fd=os.open(path,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)

class ApiError(ValueError):
 def __init__(self,status,value):
  self.status=status;self.value=value;super().__init__(str(value.get('error','HTTP '+str(status)))+': '+str(value.get('message','Request rejected')))

def api(manifest,route,payload):
 base=os.environ.get('SQUALI_URL','https://squa.li').rstrip('/');token=os.environ.get('SQUALI_TOKEN')
 if base!=manifest['origin'] or not token:raise ValueError('Set the original SQUALI_URL and a current SQUALI_TOKEN')
 request=urllib.request.Request(base+'/api/projects/'+manifest['project']+'/'+route,data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 def read(response):
  data=response.read(8*1024**2+1)
  if len(data)>8*1024**2:raise ValueError('API response exceeds 8 MiB')
  return json.loads(data)
 try:
  with urllib.request.build_opener(NoRedirect()).open(request,timeout=30) as response:return read(response)
 except urllib.error.HTTPError as error:raise ApiError(error.code,read(error)) from None

def finish_rebase(state,journal):
 response={'id':journal['id'],'status':'rebased','previousBase':journal['request']['base'],'base':journal['onto'],'changedPaths':len(journal['plan']['files'])}
 atomic_json(state/('rebase-receipt-'+journal['id']+'.json'),{'onto':journal['onto'],'resolutions':journal['request'].get('resolutions',[]),'response':response})
 (state/journal['oldImage']).unlink(missing_ok=True)
 (state/'rebase.json').unlink();sync_dir(state)
 return response

def read_resolutions(name):
 path=pathlib.Path(name)
 if path.stat().st_size>2*1024**2:raise ValueError('Resolution input exceeds 2 MiB')
 resolutions=json.loads(path.read_text())
 if not isinstance(resolutions,list):raise ValueError('Resolutions must be a JSON array')
 return resolutions

def rebase_workspace(a,state,manifest,journal,upper,root,mounted):
 if journal is None:
  journal={'id':a.id,'onto':a.onto,'oldImage':manifest.get('image','overlay.ext4'),'image':'overlay-'+a.id+'.ext4','attempts':0,'request':{'base':manifest['ref'],'onto':a.onto,'files':changes(upper,manifest,a.socket)}}
  atomic_json(state/'rebase.json',journal)
 if a.resolutions:
  resolutions=read_resolutions(a.resolutions)
  if resolutions!=journal['request'].get('resolutions',[]):
   if not journal.get('conflicts'):raise ValueError('An uncertain plan must be retried unchanged before changing resolutions')
   journal['request']['resolutions']=resolutions;journal.pop('conflicts',None);atomic_json(state/'rebase.json',journal)
 if 'plan' not in journal:
  if journal['attempts']>=8:raise ValueError('Rebase reached its eight-request limit; preserve or abort this operation')
  journal['attempts']+=1;atomic_json(state/'rebase.json',journal)
  try:plan=api(manifest,'rebase-plan',journal['request'])
  except ApiError as error:
   if error.value.get('error')=='rebase_conflict':journal['conflicts']=error.value;atomic_json(state/'rebase.json',journal)
   raise
  if plan.get('base')!=manifest['ref'] or plan.get('onto')!=a.onto or not isinstance(plan.get('files'),list):raise ValueError('Server returned an inconsistent rebase plan')
  journal['plan']=plan;journal.pop('conflicts',None);atomic_json(state/'rebase.json',journal)
 # Only one staging generation exists. A failed stage can be rebuilt from the
 # saved plan without another HTTP request or modifying the active image.
 image=state/journal['image'];image.unlink(missing_ok=True)
 with open(image,'xb') as f:os.chmod(image,0o600);f.truncate(manifest['maxBytes'])
 checked(['mkfs.ext4','-q','-F',str(image)])
 disk=root/'next';disk.mkdir();checked(['mount','-t','ext4','-o','loop,nosuid,nodev',str(image),str(disk)]);mounted.append(disk)
 upper=disk/'upper';upper.mkdir();(disk/'work').mkdir()
 for patch in journal['plan']['files']:
  relative=patch['path']
  if len(relative)>512 or '\\' in relative or any(p in ('','.','..','.git') for p in relative.split('/')):raise ValueError('Unsupported source path in rebase plan')
  path=upper/relative;path.parent.mkdir(parents=True,exist_ok=True)
  if patch['content'] is None:os.mknod(path,stat.S_IFCHR|0o600,os.makedev(0,0))
  else:
   with open(path,'x') as f:f.write(patch['content']);f.flush();os.fchmod(f.fileno(),0o755 if patch.get('mode')=='100755' else 0o644);os.fsync(f.fileno())
 next_manifest={**manifest,'ref':a.onto,'image':journal['image'],'lastRebase':a.id}
 if changes(upper,next_manifest,a.socket)!=sorted(journal['plan']['files'],key=lambda f:f['path']):raise ValueError('Staged workspace does not match the server plan')
 # Both filesystems are unmounted and the new image is durable before the one
 # atomic pointer switch. Recovery sees either the complete old or new image.
 for mount in reversed(mounted[:]):checked(['umount',str(mount)]);mounted.remove(mount)
 with open(image,'rb') as f:os.fsync(f.fileno())
 atomic_json(state/'manifest.json',next_manifest)
 print(json.dumps(finish_rebase(state,journal)))

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

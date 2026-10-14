#!/usr/bin/env python3
"""Linux read-only on-demand source filesystem. All source I/O uses the node socket.
Wire layouts follow Linux UAPI fuse.h (protocol 7.31); no FUSE Python dependency.
"""
import argparse,array,errno,json,os,pathlib,signal,socket,stat,struct,subprocess,sys
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--socket',required=True);p.add_argument('--project',required=True);p.add_argument('--mount',required=True);p.add_argument('--ref');p.add_argument('--max-inodes',type=int,default=100000);a=p.parse_args()
if sys.platform!='linux':raise SystemExit('This filesystem requires Linux /dev/fuse and fusermount3')
if not 1<=a.max_inodes<=1000000:raise SystemExit('Finite inode budget required')
def exact(s,n):
 result=b''
 while len(result)<n:
  part=s.recv(n-len(result))
  if not part:raise OSError(errno.EIO,'Node response ended')
  result+=part
 return result
def rpc(op,**args):
 with socket.socket(socket.AF_UNIX) as s:
  s.settimeout(25);s.connect(a.socket);query=json.dumps({'project':a.project,'op':op,**args}).encode();s.sendall(struct.pack('!I',len(query))+query)
  n=struct.unpack('!I',exact(s,4))[0]
  if n>65536:raise OSError(errno.EIO,'Invalid node frame')
  meta=json.loads(exact(s,n))
  if not 0<=meta['length']<=33*1024**2:raise OSError(errno.EIO,'Invalid node body size')
  data=exact(s,meta['length'])
  if meta['status']!=200:raise OSError(errno.EACCES if meta['status'] in (401,403) else errno.EIO,'Node rejected source read')
  return data if op=='object' else json.loads(data)
head=a.ref or rpc('head')['head'];raw=rpc('object',oid=head);tree=next(line[5:].decode() for line in raw.split(b'\n') if line.startswith(b'tree '))
nodes={1:{'oid':tree,'mode':stat.S_IFDIR|0o555,'size':0,'parent':1,'children':None}};handles={};next_handle=1;resident=0

def children(ino):
 node=nodes[ino]
 if not stat.S_ISDIR(node['mode']):raise OSError(errno.ENOTDIR,'Not a directory')
 if node['children'] is not None:return node['children']
 raw=rpc('object',oid=node['oid']) if node['oid'] else b'';rows=[];at=0
 while at<len(raw):
  space=raw.index(b' ',at);nul=raw.index(b'\0',space+1);mode=int(raw[at:space],8);name=raw[space+1:nul];oid=raw[nul+1:nul+21].hex()
  if len(oid)!=40 or not name or b'/' in name or name in (b'.',b'..'):raise OSError(errno.EIO,'Malformed source tree')
  rows.append((name,mode,oid));at=nul+21
 if len(nodes)+len(rows)>a.max_inodes:raise OSError(errno.ENOSPC,'Inode budget exhausted')
 sizes={};ids=list({oid for _,mode,oid in rows if stat.S_IFMT(mode) in (stat.S_IFREG,stat.S_IFLNK)})
 for begin in range(0,len(ids),2000):sizes.update({r['oid']:r['size'] for r in rpc('stat',oids=ids[begin:begin+2000])['objects']})
 result={}
 for name,mode,oid in rows:
  child=len(nodes)+1;result[name]=child
  # Gitlinks remain empty directories; importing another repository is explicit.
  gitlink=mode==0o160000;nodes[child]={'oid':None if gitlink else oid,'mode':stat.S_IFDIR|0o555 if gitlink else mode,'size':sizes.get(oid,0),'parent':ino,'children':{} if gitlink else None}
 node['children']=result;return result

def attr(ino):
 n=nodes[ino];return struct.pack('<6Q10I',ino,n['size'],(n['size']+511)//512,0,0,0,0,0,0,n['mode'],2 if stat.S_ISDIR(n['mode']) else 1,os.getuid(),os.getgid(),0,4096,0)
def dispatch(op,ino,data):
 global next_handle,resident
 if op==26:
  major,minor,read_ahead,flags=struct.unpack_from('<4I',data)
  if major!=7:raise OSError(errno.EPROTO,'Unsupported FUSE protocol')
  return struct.pack('<4I2H2I2HI7I',7,min(minor,31),min(read_ahead,131072),0,16,12,131072,1,32,0,0,*([0]*7))
 if op==1:
  name=data.split(b'\0',1)[0];child=children(ino).get(name)
  if child is None:raise OSError(errno.ENOENT,'No such path')
  return struct.pack('<4Q2I',child,1,60,60,0,0)+attr(child)
 if op==3:return struct.pack('<QII',60,0,0)+attr(ino)
 if op==5:return rpc('object',oid=nodes[ino]['oid'])
 if op in (14,27):
  flags=struct.unpack_from('<I',data)[0]
  if flags&os.O_ACCMODE:raise OSError(errno.EROFS,'Immutable mount')
  if len(handles)>=128:raise OSError(errno.EMFILE,'Open handle budget exhausted')
  fh=next_handle;next_handle+=1;handles[fh]={'ino':ino,'body':None};return struct.pack('<QII',fh,1 if op==14 else 0,0)
 if op==15:
  fh,offset,size=struct.unpack_from('<QQI',data);h=handles[fh]
  if h['body'] is None:
   expected=nodes[ino]['size']
   if resident+expected>64*1024**2:raise OSError(errno.ENOMEM,'Open content budget exhausted')
   body=rpc('object',oid=nodes[ino]['oid'])
   if len(body)!=expected:raise OSError(errno.EIO,'Source metadata size differs')
   h['body']=body;resident+=len(body)
  return h['body'][offset:offset+size]
 if op==28:
  fh,offset,size=struct.unpack_from('<QQI',data);listing=[(b'.',ino),(b'..',nodes[ino]['parent']),*children(ino).items()];out=bytearray()
  for index,(name,child) in enumerate(listing[offset:],start=offset):
   row=struct.pack('<QQII',child,index+1,len(name),stat.S_IFMT(nodes[child]['mode'])>>12)+name;row+=b'\0'*((-len(row))%8)
   if len(out)+len(row)>size:break
   out.extend(row)
  return out
 if op in (18,29):
  fh=struct.unpack_from('<Q',data)[0];h=handles.pop(fh,None)
  if h and h['body'] is not None:resident-=len(h['body'])
  return b''
 if op==17:return struct.pack('<5Q10I',0,0,0,a.max_inodes,a.max_inodes-len(nodes),4096,255,4096,0,*([0]*6))
 if op==34:
  if struct.unpack_from('<I',data)[0]&os.W_OK:raise OSError(errno.EROFS,'Immutable mount')
  return b''
 if op in (20,25,30,38,50):return b''
 if op==23:return struct.pack('<II',0,0) if struct.unpack_from('<I',data)[0]==0 else b''
 if op==22:raise OSError(errno.ENOSYS,'Extended attributes are not supported')
 if op in (4,6,8,9,10,11,12,13,16,21,24,35,43,45,47,51):raise OSError(errno.EROFS,'Immutable mount; propose edits through a writable working copy')
 raise OSError(errno.ENOSYS,'Unsupported filesystem operation')

mount=pathlib.Path(a.mount).resolve()
if not mount.is_dir() or any(mount.iterdir()):raise SystemExit('Choose an empty existing mount directory')
left,right=socket.socketpair();right.set_inheritable(True)
proc=subprocess.Popen(['fusermount3','-o','ro,nosuid,nodev,fsname=squali,subtype=squali,max_read=131072',str(mount)],env={**os.environ,'_FUSE_COMMFD':str(right.fileno())},pass_fds=(right.fileno(),),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);right.close();left.settimeout(10)
_,ancillary,_,_=left.recvmsg(1,socket.CMSG_SPACE(4));left.close();fds=array.array('i')
for level,kind,body in ancillary:
 if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:fds.frombytes(body[:len(body)-len(body)%fds.itemsize])
if not fds:raise SystemExit('fusermount3 did not return a device: '+proc.communicate(timeout=10)[1].decode())
fd=fds[0];proc.wait(timeout=10)
def terminate(*_):raise SystemExit(0)
signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
print(json.dumps({'ready':True,'mount':str(mount),'ref':head,'source':'node-socket'}),flush=True)
try:
 while True:
  try:request=os.read(fd,1024*1024)
  except OSError as error:
   if error.errno==errno.ENODEV:break
   raise
  if not request:break
  length,op,unique,ino=struct.unpack_from('<IIQQ',request)
  if op in (2,36,41,42):continue
  try:body=dispatch(op,ino,request[40:length]);error=0
  except OSError as failure:error=-int(failure.errno or errno.EIO);body=b''
  except (KeyError,ValueError,struct.error,StopIteration):error=-errno.EIO;body=b''
  os.write(fd,struct.pack('<IiQ',16+len(body),error,unique)+body)
finally:
 os.close(fd);subprocess.run(['fusermount3','-u',str(mount)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)

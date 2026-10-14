#!/usr/bin/env python3
"""Linux FUSE acceptance through ordinary filesystem commands and two shared-node mounts."""
import argparse,pathlib,os,subprocess,json,socket,struct,time,hashlib,select,sys
p=argparse.ArgumentParser();p.add_argument('--work',required=True);p.add_argument('--reuse-cache',action='store_true');a=p.parse_args();root=pathlib.Path(a.work);root.mkdir(mode=0o700,parents=True,exist_ok=True)
repo=pathlib.Path(__file__).resolve().parent.parent;project=os.environ.get('SQUALI_PROJECT','scion-source-pilot');sock=str(root/'node.sock');processes=[];mounts=[];logs=[]
def exact(s,n):
 data=b''
 while len(data)<n:
  part=s.recv(n-len(data))
  if not part:raise RuntimeError('Truncated socket reply')
  data+=part
 return data
def rpc(query):
 with socket.socket(socket.AF_UNIX) as s:
  s.settimeout(30);s.connect(sock);body=json.dumps(query).encode();s.sendall(struct.pack('!I',len(body))+body);size=struct.unpack('!I',exact(s,4))[0];meta=json.loads(exact(s,size));data=exact(s,meta['length']);assert meta['status']==200,(meta,data[:200]);return json.loads(data)
def start(args,name,env):
 log=open(root/(name+'.stderr'),'w');logs.append(log);proc=subprocess.Popen(args,cwd=repo,env=env,stdout=subprocess.PIPE,stderr=log,text=True);processes.append(proc)
 if not select.select([proc.stdout],[],[],30)[0]:raise RuntimeError('Startup timed out: '+name)
 line=proc.stdout.readline()
 if not line:raise RuntimeError('Startup failed: '+name+' '+(root/(name+'.stderr')).read_text()[-2000:])
 assert json.loads(line)['ready'];return proc
def command(*args):
 result=subprocess.run(args,capture_output=True,timeout=25,check=True);assert not result.stderr,result.stderr.decode();return result.stdout
try:
 daemon=start(['python3','scripts/node-daemon.py','--socket',sock,'--cache',str(root/'cache'),'--max-bytes','16777216'],'daemon',os.environ.copy())
 clean={k:v for k,v in os.environ.items() if k not in ('SQUALI_TOKEN','SQUALI_URL')}
 t=time.monotonic()
 for i in range(2):
  target=root/('mount-'+str(i));target.mkdir(exist_ok=True);mounts.append(target);start(['python3','scripts/squali-fuse.py','--socket',sock,'--project',project,'--mount',str(target)],'fuse-'+str(i),clean)
 mounted_ms=round((time.monotonic()-t)*1000,2);initial=rpc({'op':'stats'});assert initial['originBlobs']==0
 listing=command('ls','-la',str(mounts[0])).decode();assert 'README.md' in listing and 'binary.dat' in listing
 assert command('stat','-c','%s',str(mounts[0]/'binary.dat')).strip()==b'4096';assert rpc({'op':'stats'})['originBlobs']==0,'Directory inspection downloaded file bodies'
 expected=b'# Durable source fixture\nNative history retained.\n';assert command('cat',str(mounts[0]/'README.md'))==expected
 binary=b''.join(hashlib.sha256(str(i).encode()).digest() for i in range(128));assert command('cat',str(mounts[0]/'binary.dat'))==binary
 cold=rpc({'op':'stats'});assert cold['originBlobs']==(0 if a.reuse_cache else 2)
 assert command('cat',str(mounts[1]/'README.md'))==expected;assert command('cat',str(mounts[1]/'binary.dat'))==binary
 warm=rpc({'op':'stats'});assert warm['originBlobs']==(0 if a.reuse_cache else 2),'Second mount bypassed the shared cache'
 daemon.terminate();daemon.wait(timeout=10);failed=subprocess.run(['cat',str(mounts[1]/'binary.dat')],capture_output=True,timeout=10);assert failed.returncode!=0,'Missing daemon must not cause a direct authority fallback'
 report={'command':'SQUALI_PROJECT='+project+' python3 tests/fuse-e2e.py --work '+str(root)+(' --reuse-cache' if a.reuse_cache else ''),'mountedMs':mounted_ms,'mounts':2,'directoryContentReads':0,'nativeReadExact':True,'binaryBytes':4096,'cold':cold,'warm':warm,'daemonFailureIsolated':True,'passed':True}
 (root/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
finally:
 for target in mounts:subprocess.run(['fusermount3','-u',str(target)],capture_output=True,timeout=10)
 for proc in reversed(processes):
  if proc.poll() is None:
   proc.terminate()
   try:proc.wait(timeout=10)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
 for f in logs:f.close()

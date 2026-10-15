#!/usr/bin/env python3
"""Real Linux mount and proposal acceptance, invoked by the local HTTP fixture."""
import argparse,json,os,pathlib,select,subprocess,tempfile,shutil,socket,struct,time
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--ref',required=True);a=p.parse_args()
root=pathlib.Path(tempfile.mkdtemp(prefix='squali-vfs-e2e-'));daemon=None
def stats():
 def exact(s,n):
  data=b''
  while len(data)<n:
   part=s.recv(n-len(data));assert part;data+=part
  return data
 with socket.socket(socket.AF_UNIX) as s:
  s.connect(str(root/'node.sock'));q=b'{"op":"stats"}';s.sendall(struct.pack('!I',len(q))+q)
  meta=json.loads(exact(s,struct.unpack('!I',exact(s,4))[0]));assert meta['status']==200
  return json.loads(exact(s,meta['length']))
def run(*args,**options):
 return subprocess.run(args,cwd=a.repo,text=True,capture_output=True,timeout=45,**options)
try:
 log=open(root/'daemon.log','w')
 daemon=subprocess.Popen(['python3','scripts/node-daemon.py','--socket',str(root/'node.sock'),'--cache',str(root/'cache'),'--max-bytes','16777216'],cwd=a.repo,stdout=subprocess.PIPE,stderr=log,text=True)
 assert select.select([daemon.stdout],[],[],10)[0], 'Daemon startup timeout'
 assert json.loads(daemon.stdout.readline())['ready']
 base=['python3','scripts/virtual-workspace.py','run','--socket',str(root/'node.sock'),'--project','virtual-fs','--ref',a.ref,'--state',str(root/'workspace'),'--max-bytes','67108864']
 edits="""import os,pathlib,shutil
p=pathlib.Path('.')
assert (p/'README.md').read_text()=='original\\n'
(p/'README.tmp').write_text('changed\\n');os.replace(p/'README.tmp',p/'README.md')
(p/'src/new.txt').write_text('new file\\n');(p/'src/remove.txt').unlink()
(p/'tool.sh').write_text('#!/bin/sh\\necho new\\n');(p/'tool.sh').chmod(0o644)
shutil.rmtree(p/'reset');(p/'reset').mkdir();(p/'reset/keep.txt').write_text('keep same content\\n')
"""
 first=run(*base,'--','python3','-c',edits);assert first.returncode==0,first.stderr
 cold=stats();assert 1<=cold['originBlobs']<=2,cold
 second=run(*base,'--','python3','-c',"from pathlib import Path; assert Path('README.md').read_text()=='changed\\n'; assert not Path('src/remove.txt').exists()")
 assert second.returncode==0,second.stderr
 assert stats()['originBlobs']==cold['originBlobs'],'Restart must reuse upper data and shared node objects'
 mismatch=[*base];mismatch[mismatch.index('--ref')+1]='a'*40
 wrong=run(*mismatch,'--','true');assert wrong.returncode!=0 and 'pinned' in wrong.stderr,wrong.stderr
 lock_check=f"import subprocess; r=subprocess.run({base!r},cwd={a.repo!r},capture_output=True,text=True); assert r.returncode!=0 and 'already mounted' in r.stderr,r.stderr"
 locked=run(*base,'--','python3','-c',lock_check);assert locked.returncode==0,locked.stderr
 quota="""import errno,pathlib
p=pathlib.Path('quota-test.bin')
try:
 with p.open('wb') as f:
  for _ in range(80): f.write(b'0'*1048576)
 raise AssertionError('Fixed overlay disk did not enforce its capacity')
except OSError as e: assert e.errno==errno.ENOSPC,e
finally: p.unlink(missing_ok=True)
"""
 full=run(*base,'--','python3','-c',quota);assert full.returncode==0,full.stderr
 invalid=run('python3','scripts/virtual-workspace.py','propose','--state',str(root/'workspace'),'--socket',str(root/'node.sock'),'--id','invalid-title','--title','x'*201)
 assert invalid.returncode!=0 and not (root/'workspace'/'pending-invalid-title.json').exists(),'Invalid input must be rejected before recording or sending a proposal'
 proposal=run('python3','scripts/virtual-workspace.py','propose','--state',str(root/'workspace'),'--socket',str(root/'node.sock'),'--id','virtual-edit','--title','Virtual filesystem edits')
 assert proposal.returncode!=0,'The first response should be lost after server acceptance'
 assert (root/'workspace'/'pending-virtual-edit.json').exists()
 # A subsequent local edit cannot alter the frozen request used by the retry.
 changed=run(*base,'--','python3','-c',"from pathlib import Path; Path('README.md').write_text('edited after uncertain response\\n')")
 assert changed.returncode==0,changed.stderr
 proposal=run('python3','scripts/virtual-workspace.py','propose','--state',str(root/'workspace'),'--socket',str(root/'node.sock'),'--id','virtual-edit','--title','Virtual filesystem edits')
 assert proposal.returncode==0,proposal.stderr
 receipt=json.loads(proposal.stdout.strip().split('\n')[-1]);assert receipt['oid']
 # Replaying the same accepted operation returns the receipt without networking.
 replay=run('python3','scripts/virtual-workspace.py','propose','--state',str(root/'workspace'),'--socket',str(root/'missing.sock'),'--id','virtual-edit','--title','Virtual filesystem edits',env={**os.environ,'SQUALI_URL':'http://127.0.0.1:1'})
 assert replay.returncode==0,replay.stderr
 assert json.loads(replay.stdout.strip().split('\n')[-1])==receipt
 assert (root/'workspace'/'overlay.ext4').stat().st_size==67108864
 # A command's background descendants must not keep its mount or loop disk alive.
 child_pid=root/'child.pid'
 spawn_child=f"import pathlib,subprocess; p=subprocess.Popen(['sleep','60'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); pathlib.Path({str(child_pid)!r}).write_text(str(p.pid))"
 background=run(*base,'--','python3','-c',spawn_child)
 assert background.returncode==0,background.stderr
 assert not run('losetup','-j',str(root/'workspace'/'overlay.ext4')).stdout.strip(),'A background child retained the mounted image'
 crash="""import os,time,pathlib
with open('survivor.txt','w') as f: f.write('durable before process death\\n');f.flush();os.fsync(f.fileno())
"""+f"pathlib.Path({str(root/'crash-ready')!r}).write_text('ready')\ntime.sleep(30)\n"
 supervisor=subprocess.Popen([*base,'--','python3','-c',crash],cwd=a.repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  end=time.monotonic()+10
  while not (root/'crash-ready').exists() and time.monotonic()<end and supervisor.poll() is None:time.sleep(.02)
  assert (root/'crash-ready').exists(),'Crash fixture did not reach fsync'
 finally:supervisor.kill();supervisor.communicate(timeout=5)
 recovered=run(*base,'--','python3','-c',"from pathlib import Path; assert Path('survivor.txt').read_text()=='durable before process death\\n'")
 assert recovered.returncode==0,recovered.stderr
 daemon.terminate();daemon.wait(timeout=5)
 stopped=run(*base,'--','cat','src/keep.txt');assert stopped.returncode!=0,'No direct authority fallback when the node is absent'
 print(json.dumps({'passed':True,'ordinaryWrites':True,'atomicRename':True,'delete':True,'restartPreservesEdits':True,'receiptReplayOffline':True,'lostAcknowledgementRecovered':True,'retryPayloadFrozen':True,'maxOverlayBytes':67108864,'diskFullRejected':True,'exclusiveMount':True,'baseMismatchRejected':True,'backgroundChildrenStopped':True,'forcedProcessDeathRecovered':True,'daemonFailureIsolated':True,'bodyReads':cold['originBlobs']}))
finally:
 if daemon:
  daemon.terminate()
  try:daemon.wait(timeout=5)
  except subprocess.TimeoutExpired:daemon.kill();daemon.wait()
 shutil.rmtree(root)

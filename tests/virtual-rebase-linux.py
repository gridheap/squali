#!/usr/bin/env python3
"""Rebase through the real CLI, Linux overlay and local HTTP service."""
import argparse,json,os,pathlib,select,subprocess,tempfile,shutil,socket,struct
p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--ref',required=True);p.add_argument('--onto',required=True);p.add_argument('--conflict',required=True);a=p.parse_args()
root=pathlib.Path(tempfile.mkdtemp(prefix='squali-rebase-e2e-'));daemon=None
try:
 daemon=subprocess.Popen(['python3','scripts/node-daemon.py','--socket',str(root/'node.sock'),'--cache',str(root/'cache'),'--max-bytes','16777216'],cwd=a.repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 assert select.select([daemon.stdout],[],[],10)[0];assert json.loads(daemon.stdout.readline())['ready']
 common=['--state',str(root/'workspace'),'--socket',str(root/'node.sock')]
 def cli(action,*args,ok=True,env=None):
  r=subprocess.run(['python3','scripts/virtual-workspace.py',action,*common,*args],cwd=a.repo,capture_output=True,text=True,timeout=45,env=env)
  if ok:assert r.returncode==0,r.stderr
  else:assert r.returncode!=0,r.stdout
  return r
 def value(r):return json.loads(r.stdout.strip().split('\n')[-1])
 def stats():
  with socket.socket(socket.AF_UNIX) as s:
   s.connect(str(root/'node.sock'));body=b'{"op":"stats"}';s.sendall(struct.pack('!I',len(body))+body);stream=s.makefile('rb');n=struct.unpack('!I',stream.read(4))[0];meta=json.loads(stream.read(n));assert meta['status']==200;return json.loads(stream.read(meta['length']))
 cli('run','--project','virtual-rebase','--ref',a.ref,'--max-bytes','67108864','--','python3','-c',"from pathlib import Path; p=Path('text'); s=p.read_text().splitlines();s[10]='local';p.write_text('\\n'.join(s)+'\\n');Path('delete').unlink();Path('new').write_text('local addition\\n');Path('tool').chmod(0o755)")
 rebase=['--id','first','--onto',a.onto]
 initial_blobs=stats()['originBlobs']
 cli('rebase',*rebase,ok=False) # successful server answer is deliberately lost
 assert json.loads((root/'workspace/manifest.json').read_text())['ref']==a.ref
 blocked=cli('run','--','true',ok=False);assert 'pending' in blocked.stderr
 cli('rebase','--id','first','--onto',a.conflict,ok=False)
 done=value(cli('rebase',*rebase));assert done['base']==a.onto
 assert stats()['originBlobs']==initial_blobs,'Rebase must stage changed text from the server without fetching working-tree bodies'
 offline={**os.environ,'SQUALI_URL':'http://127.0.0.1:1'}
 assert value(cli('rebase',*rebase,env=offline))==done
 check="from pathlib import Path; s=Path('text').read_text().splitlines();assert s[0]=='remote' and s[10]=='local';assert Path('remote').read_text()=='remote addition\\n';assert Path('tool').read_text()=='remote tool\\n';assert Path('tool').stat().st_mode&0o111;assert not Path('delete').exists();assert Path('new').read_text()=='local addition\\n'"
 cli('run','--', 'python3','-c',check)
 status=value(cli('status'));assert status['base']==a.onto;assert len(status['changes'])==4
 cli('propose','--id','rebased-edit','--title','Rebased local edits')
 failure=cli('rebase','--id','conflicted','--onto',a.conflict,ok=False);assert 'rebase_conflict' in failure.stderr
 assert json.loads((root/'workspace/manifest.json').read_text())['ref']==a.onto
 cli('abort-rebase','--id','conflicted');cli('run','--','python3','-c',check)
 cli('rebase','--id','resolved','--onto',a.conflict,ok=False)
 resolutions=root/'resolutions.json';resolutions.write_text(json.dumps([{'path':'text','content':'explicitly resolved\n'}]))
 resolved=value(cli('rebase','--id','resolved','--onto',a.conflict,'--resolutions',str(resolutions)));assert resolved['base']==a.conflict
 resolutions.write_text(json.dumps([{'path':'text','content':'a different resolution\n'}]))
 changed_receipt=cli('rebase','--id','resolved','--onto',a.conflict,'--resolutions',str(resolutions),env=offline,ok=False)
 assert 'resolution' in changed_receipt.stderr
 cli('run','--','python3','-c',"from pathlib import Path;assert Path('text').read_text()=='explicitly resolved\\n';assert Path('new').read_text()=='local addition\\n';assert not Path('delete').exists()")
 # Fault at the real atomic rename boundary, inside the same CLI/process and
 # mount namespace. No production fault hook or mocked filesystem is needed.
 def crash_cli(action,args,when,operation='replace'):
  script=str(pathlib.Path(a.repo)/'scripts/virtual-workspace.py')
  code="import os,sys,runpy,pathlib,signal\nm=runpy.run_path("+repr(script)+")\noriginal=os."+operation+"\ndef fault(*args,**kw):\n hit=str(args["+('1' if operation=='replace' else '0')+"]).endswith("+repr('manifest.json' if operation=='replace' else 'rebase.json')+")\n if hit and "+repr(when=='before')+":os._exit(137)\n result=original(*args,**kw)\n if hit:os._exit(137)\n return result\nos."+operation+"=fault\nsys.argv="+repr([script,action,'--isolated',*common,*args])+"\nm['main']()"
  r=subprocess.run(['unshare','--mount','--pid','--mount-proc','--fork','--kill-child','--','python3','-c',code],cwd=a.repo,capture_output=True,text=True,timeout=45)
  assert r.returncode!=0,r.stdout
 for boundary in ['before','after']:
  previous=json.loads((root/'workspace/manifest.json').read_text())
  args=['--id','crash-'+boundary,'--onto',a.conflict]
  crash_cli('rebase',args,boundary)
  current=json.loads((root/'workspace/manifest.json').read_text())
  assert (current['image']==previous['image'])==(boundary=='before')
  replay=value(cli('rebase',*args,env=offline));assert replay['status']=='rebased'
  cli('run','--','python3','-c',"from pathlib import Path;assert Path('text').read_text()=='explicitly resolved\\n'")
 # Abort's receipt must survive a process death before deleting its journal.
 cli('rebase','--id','abort-crash','--onto','f'*40,ok=False)
 crash_cli('abort-rebase',['--id','abort-crash'],'before','unlink')
 cli('run','--','true')
 assert len(list((root/'workspace').glob('*.ext4')))==1,'Retired generations must not accumulate'
 print(json.dumps({'passed':True,'inPlaceRebase':True,'dirtyContentAndModesPreserved':True,'serverMerge':True,'rebaseClientBlobReads':0,'lostPlanResponse':True,'frozenMutationBlocked':True,'offlineReceipt':True,'changedResolutionRejected':True,'conflictsPreserveOriginal':True,'explicitResolution':True,'abort':True,'retiredImagesRemoved':True,'crashBeforeSwitchRecovered':True,'crashAfterSwitchRecovered':True,'interruptedAbortRecovered':True}))
finally:
 if daemon:
  daemon.terminate()
  try:daemon.wait(timeout=5)
  except subprocess.TimeoutExpired:daemon.kill();daemon.wait()
 shutil.rmtree(root)

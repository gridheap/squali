#!/usr/bin/env python3
"""Finite local capacity run with an isolated PostgreSQL and process-tree sampling."""
import argparse,json,os,pathlib,resource,signal,socket,subprocess,sys,tempfile,threading,time
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--quick',action='store_true');p.add_argument('--sustained',action='store_true');a=p.parse_args()
output=pathlib.Path(a.output).resolve();output.mkdir(parents=True,exist_ok=True)
if (output/'resources.json').exists():print('Retained result: '+str(output/'resources.json'));raise SystemExit(0)
if (output/'started.json').exists():raise SystemExit('Interrupted run retained; inspect it before choosing a distinct run')
(output/'started.json').write_text(json.dumps({'command':' '.join(sys.argv),'at':time.time(),'externalProviderCalls':0}))
pgbin=pathlib.Path('/Users/binbinsh/.local/share/mise/installs/postgres/17.11/bin')
if not (pgbin/'postgres').exists():raise SystemExit('Pinned local PostgreSQL 17.11 is required')
root=pathlib.Path(tempfile.mkdtemp(prefix='capacity-',dir='work')).resolve();pg=None;child=None;stop=threading.Event();samples=[];known={};phase='setup'
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
def cpu(value):
 parts=value.split(':');return sum(float(n)*60**i for i,n in enumerate(reversed(parts)))
def sample():
 while not stop.is_set():
  stamp=time.monotonic()
  rows={}
  for line in subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,time=,comm='],text=True).splitlines():
   fields=line.split(None,4)
   if len(fields)==5:rows[int(fields[0])]=(int(fields[1]),int(fields[2])*1024,cpu(fields[3]),fields[4])
  descendants={x.pid for x in (pg,child) if x and x.poll() is None}
  for _ in range(12):
   extra={pid for pid,row in rows.items() if row[0] in descendants};new=descendants|extra
   if new==descendants:break
   descendants=new
  try:current=json.loads((output/'phase.json').read_text())['name']
  except (FileNotFoundError,ValueError):current='setup'
  groups={}
  for pid in descendants:
   if pid not in rows:continue
   _,rss,seconds,command=rows[pid];name='postgres' if 'postgres' in command else 'workerd' if 'workerd' in command else 'python' if 'python' in command.lower() else 'git' if pathlib.Path(command).name=='git' else 'node-and-runner'
   row=groups.setdefault(name,{'rssBytes':0,'sampledCpuSeconds':0,'processes':0});row['rssBytes']+=rss;row['processes']+=1;row['sampledCpuSeconds']+=max(0,seconds-known.get(pid,seconds));known[pid]=seconds
  samples.append({'seconds':stamp-start,'phase':current,'groups':groups})
  stop.wait(.1)
start=time.monotonic();before=resource.getrusage(resource.RUSAGE_CHILDREN);thread=None;code=1
try:
 with open(output/'postgres.log','w') as log:
  subprocess.run([str(pgbin/'initdb'),'-D',str(root/'db'),'-U','weave','--auth=trust','--no-locale'],stdout=log,stderr=log,check=True,timeout=30)
  pg=subprocess.Popen([str(pgbin/'postgres'),'-D',str(root/'db'),'-p',str(port),'-h','127.0.0.1','-k','','-c','max_connections=24','-c','shared_buffers=64MB'],stdout=log,stderr=log)
  for _ in range(100):
   if subprocess.run([str(pgbin/'pg_isready'),'-h','127.0.0.1','-p',str(port)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
   time.sleep(.05)
  else:raise RuntimeError('PostgreSQL startup failed')
  env={**os.environ,'DATABASE_URL':f'postgres://weave@127.0.0.1:{port}/postgres','CAPACITY_OUTPUT':str(output),'CAPACITY_QUICK':'1' if a.quick else '0','CAPACITY_SUSTAINED':'1' if a.sustained else '0','WRANGLER_SEND_METRICS':'false'}
  with open(output/'transcript.txt','w') as transcript:
   child=subprocess.Popen(['node','--import','tsx','tests/capacity.e2e.ts'],env=env,stdout=transcript,stderr=subprocess.STDOUT,start_new_session=True)
   thread=threading.Thread(target=sample);thread.start()
   try:code=child.wait(timeout=900)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=20);raise
finally:
 if child and child.poll() is None:os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=20)
 if pg and pg.poll() is None:pg.send_signal(signal.SIGINT);pg.wait(timeout=30)
 stop.set()
 if thread:thread.join(timeout=5)
 after=resource.getrusage(resource.RUSAGE_CHILDREN)
 phases={}
 for s in samples:
  r=phases.setdefault(s['phase'],{'sampleCount':0,'peakSummedRssBytes':0,'groups':{}});r['sampleCount']+=1;r['peakSummedRssBytes']=max(r['peakSummedRssBytes'],sum(g['rssBytes'] for g in s['groups'].values()))
  for name,g in s['groups'].items():
   v=r['groups'].setdefault(name,{'peakRssBytes':0,'sampledCpuSeconds':0});v['peakRssBytes']=max(v['peakRssBytes'],g['rssBytes']);v['sampledCpuSeconds']+=g['sampledCpuSeconds']
 report={'command':' '.join(sys.argv),'exitCode':code,'wallSeconds':time.monotonic()-start,'childCpuSeconds':{'user':after.ru_utime-before.ru_utime,'system':after.ru_stime-before.ru_stime},'peakSummedRssBytes':max((r['peakSummedRssBytes'] for r in phases.values()),default=0),'phases':phases,'sampleIntervalMs':100,'postgres':{'version':'17.11','maxConnections':24,'sharedBuffersMiB':64,'isolated':True},'fixtureDirectory':str(root),'externalProviderCalls':0,'limitations':['Sampled RSS sums resident pages across processes and can double-count shared PostgreSQL pages; it is not unique physical memory.','Per-phase CPU from ps has 10 ms precision and can miss short-lived processes. Whole-run wait accounting includes child processes plus the ps sampler and setup.','Node CPU includes the HTTP load generator in the source process; Worker/isolate CPU billing is not inferred from these local counters.']}
 (output/'resources.json').write_text(json.dumps(report,indent=2)+'\n');(output/'resource-samples.json').write_text(json.dumps(samples)+'\n');print(json.dumps({'exitCode':code,'wallSeconds':report['wallSeconds'],'peakSummedRssMiB':report['peakSummedRssBytes']/1024**2,'childCpuSeconds':report['childCpuSeconds']}))
raise SystemExit(code)

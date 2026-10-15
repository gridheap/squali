"""Plan native Git bootstrap using only frozen original refs, without network I/O."""
import argparse,hashlib,json,os,pathlib,subprocess,time

def plan(repository,refs,inventory,max_objects=16384,max_bytes=256*1024*1024,max_pushes=128,inspect=False):
 if not 16<=max_objects<=32768 or not 1024<=max_bytes<=256*1024*1024 or not 1<=max_pushes<=256:raise RuntimeError('Invalid finite Git seed policy')
 started=time.monotonic()
 def git(*args,data=None):
  if time.monotonic()-started>600:raise RuntimeError('Git seed planning exceeds ten minutes')
  result=subprocess.run(['git','-C',str(repository),*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
  if result.returncode:raise RuntimeError('Git seed planning failed: '+args[0])
  if len(result.stdout)>64*1024*1024:raise RuntimeError('Git seed planning output exceeds 64 MiB')
  return result.stdout.decode().splitlines()
 sizes={line.split()[0]:int(line.split()[2]) for line in pathlib.Path(inventory).read_text().splitlines()}
 order={oid:i for i,oid in enumerate(git('rev-list','--reverse','--topo-order','--all'))}
 peeled=git('cat-file','--batch-check=%(objectname)',data=''.join(r['oid']+'^{}\n' for r in refs).encode())
 if len(peeled)!=len(refs):raise RuntimeError('Git seed peeling failed')
 ordered=[r for _,r in sorted(zip(peeled,refs),key=lambda pair:(order.get(pair[0],-1),pair[1]['name']))]
 batches=[];previous=[];seen=set();violations=[]
 def add(group):
  data=''.join(r['oid']+'\n' for r in group)+''.join('^'+oid+'\n' for oid in previous)
  objects=set(git('rev-list','--objects','--no-object-names','--stdin',data=data.encode()))
  if any(oid not in sizes for oid in objects):raise RuntimeError('Seed contains an object outside the frozen source inventory')
  size=sum(sizes[oid] for oid in objects)
  if len(objects)>max_objects or size>max_bytes:
   if len(group)==1:
    message='One original ref exceeds the Git seed step budget: '+group[0]['name']+' ('+str(len(objects))+' objects, '+str(size)+' raw bytes)'
    if not inspect:raise RuntimeError(message)
    violations.append(message)
   else:
    middle=len(group)//2;add(group[:middle]);add(group[middle:]);return
  if len(batches)>=max_pushes and not inspect:raise RuntimeError('Git seed exceeds the total push ceiling')
  batches.append({'refs':group,'newObjects':len(objects),'rawBytes':size,'objectsSha256':hashlib.sha256(('\n'.join(sorted(objects))+'\n').encode()).hexdigest()});previous.extend(r['oid'] for r in group);seen.update(objects)
 for i in range(0,len(ordered),32):add(ordered[i:i+32])
 if len(batches)>max_pushes:violations.append('Git seed exceeds the total push ceiling')
 return {'version':1,'admissible':not violations,'violations':violations,'transferRawBytes':sum(b['rawBytes'] for b in batches),'policy':{'maxObjects':max_objects,'maxRawBytes':max_bytes,'maxPushes':max_pushes},'refs':refs,'batches':batches,'objects':len(seen),'rawBytes':sum(sizes[oid] for oid in seen),'planningSeconds':round(time.monotonic()-started,3)}

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('repository');p.add_argument('--state',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 root=pathlib.Path(a.state);state=json.loads((root/'state.json').read_text());output=pathlib.Path(a.output)
 if output.exists():raise SystemExit('Inspect the retained plan instead of repeating it')
 result=plan(a.repository,state['identity']['refs'],root/'objects.txt',inspect=True);output.write_text(json.dumps(result,indent=2)+'\n');output.chmod(0o600)
 print(json.dumps({'output':str(output),'admissible':result['admissible'],'violations':result['violations'],'transferRawBytes':result['transferRawBytes'],'batches':len(result['batches']),'objects':result['objects'],'rawBytes':result['rawBytes'],'maxStepObjects':max(b['newObjects'] for b in result['batches']),'maxStepRawBytes':max(b['rawBytes'] for b in result['batches']),'planningSeconds':result['planningSeconds'],'policy':result['policy']}))

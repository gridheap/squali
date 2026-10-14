"""Bounded local reproduction for native filesystem event delivery: six processes."""
import json,pathlib,subprocess
root=pathlib.Path('work/watch-event-probe');root.mkdir(parents=True,exist_ok=True)
command=['node','--import','tsx','--test','--test-name-pattern=event limit','tests/working-copy-watch.test.ts']
processes=[]
for index in range(6):
 out=(root/(str(index)+'.txt')).open('w');processes.append((index,subprocess.Popen(command,stdout=out,stderr=subprocess.STDOUT),out))
results=[]
for index,process,out in processes:
 code=process.wait(timeout=20);out.close();results.append({'sample':index,'exit':code,'report':str(root/(str(index)+'.txt'))})
print(json.dumps({'command':command,'results':results},indent=2))

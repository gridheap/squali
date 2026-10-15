"""Compare retained Squali blame with one pinned GitHub blame response; no network."""
import argparse,json,pathlib
p=argparse.ArgumentParser();p.add_argument('actual');p.add_argument('upstream');p.add_argument('--regressions');a=p.parse_args()
actual=json.loads(pathlib.Path(a.actual).read_text());upstream=json.loads(pathlib.Path(a.upstream).read_text())['data']['repository']['object'];assert actual['ref']==upstream['oid']
expected={i:r['commit']['oid'] for r in upstream['blame']['ranges'] for i in range(r['startingLine'],r['endingLine']+1)}
assert len(actual['lines'])==len(expected)
errors=[{'line':i,'actual':r['commit'],'expected':expected.get(i)} for i,r in enumerate(actual['lines'],1) if r['commit']!=expected.get(i)]
assert not errors,errors
points=[]
if a.regressions:
 for point in json.loads(pathlib.Path(a.regressions).read_text()):
  row=actual['lines'][point['line']-1];assert [row['commit'],row['originalLine']]==point['native'],point;points.append(point['line'])
print(json.dumps({'command':'python3 scripts/compare-blame-report.py '+a.actual+' '+a.upstream+(' --regressions '+a.regressions if a.regressions else ''),'head':actual['ref'],'path':actual['path'],'lines':len(expected),'allFullCommitOriginsMatch':True,'nativeOriginalLineRegressionPoints':points,'httpCalls':0,'gitTransfers':0,'limits':['GitHub ranges supply commit origins, not original line positions; positions at the named regression points come from retained native acceptance evidence.']},indent=2))

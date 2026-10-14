import {watch,constants} from 'node:fs';
import {lstat,readFile,readdir,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

// A local observer. It never reads credentials, invokes the service, tracks a new
// file, or changes the working-copy manifest. Explicit status/propose remain the
// authority for committing edits. Reopening reconstructs state after a missed event.
export async function watchWorkingCopy(args){
 const [directory,...flags]=args;if(!directory)throw Error('watch <directory> [--seconds 60] [--max-events 10000]');
 const options={seconds:60,'max-events':10000};
 for(let i=0;i<flags.length;i+=2){const key=flags[i].replace(/^--/,''),value=Number(flags[i+1]);if(!(key in options)||!Number.isInteger(value)||value<1||value>(key==='seconds'?3600:10000))throw Error('Use 1–3600 seconds and 1–10000 native events');options[key]=value;}
 const root=resolve(directory),meta=join(root,'.squali'),manifestPath=join(meta,'manifest.json');
 for(const path of [root,meta]){const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Working-copy directories must not be symlinks');}
 const manifestStat=await lstat(manifestPath);if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>2*1024*1024)throw Error('Invalid bounded working-copy manifest');
 const manifestText=await readFile(manifestPath,'utf8'),manifest=JSON.parse(manifestText);
 const safe=path=>typeof path==='string'&&path.length<=4096&&!path.startsWith('/')&&!path.includes('\\')&&!/[\x00-\x1f]/.test(path)&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='.squali'&&p.toLowerCase()!=='.git');
 if(manifest.version!==1||!manifest.files||!Array.isArray(manifest.paths)||!manifest.paths.length||Object.keys(manifest.files).length>10000||!manifest.paths.every(safe)||!Object.keys(manifest.files).every(safe))throw Error('Invalid working-copy selection');
 try{await lstat(join(meta,'update.json'));throw Error('Finish the pending update before watching');}catch(error){if(error.code!=='ENOENT')throw error;}
 const selected=path=>manifest.paths.some(scope=>path===scope||path.startsWith(scope+'/'));
 const ancestor=path=>manifest.paths.some(scope=>scope.startsWith(path+'/'));
 const watches=new Map(),cached=new Map();let changes=new Map(),events=0,hashedBytes=0,entries=0,peakWatches=0,closed=false,reason='time-limit',failure=null,debounce,deadline,tail=Promise.resolve(),settle;
 const ended=new Promise(done=>{settle=done;});
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
 function stop(why,error){if(closed)return;closed=true;reason=why;failure=error??null;clearTimeout(debounce);clearTimeout(deadline);for(const handle of watches.values())handle.close();watches.clear();settle();}
 function attach(path,relative,metadata=false){if(closed||watches.has(path))return;if(watches.size>=4096)throw Error('Watch exceeds 4,096 directories');
  const handle=watch(path,(kind,name)=>{
   const filename=name?.toString();if(metadata){if(filename===undefined||filename==='manifest.json')stop('manifest-changed',Error('Working-copy base changed; restart the watcher'));return;}
   const changed=filename?(relative?relative+'/':'')+filename:null;
   if(changed&&(!safe(changed)||!selected(changed)&&!ancestor(changed)))return;
   if(++events>=options['max-events']){stop('event-limit');return;}
   if(!debounce)debounce=setTimeout(()=>{debounce=null;tail=tail.then(()=>scan(false)).catch(error=>stop('rescan-required',error));},100);
  });handle.on('error',error=>stop('rescan-required',error));watches.set(path,handle);peakWatches=Math.max(peakWatches,watches.size);
 }
 async function identity(path,info){
  const fingerprint=[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs,info.mode].join(':');const saved=cached.get(path);if(saved?.fingerprint===fingerprint)return saved.oid;
  if(info.size>32n*1024n*1024n)throw Error('A tracked file exceeds the 32 MiB inspection limit');
  const file=await open(join(root,path),constants.O_RDONLY|constants.O_NOFOLLOW);let bytes=0;const digest=createHash('sha1').update(`blob ${info.size}\0`);
  try{for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;hashedBytes+=chunk.length;if(bytes>32*1024*1024||hashedBytes>256*1024*1024)throw Error('Watcher content inspection exceeds its 256 MiB budget');digest.update(chunk);}const end=await file.stat({bigint:true});if(BigInt(bytes)!==info.size||end.mtimeNs!==info.mtimeNs||end.ctimeNs!==info.ctimeNs)throw Error('File changed during inspection; restart to reconcile');}finally{await file.close();}
  const oid=digest.digest('hex');cached.set(path,{fingerprint,oid});return oid;
 }
 async function scan(initial){
  const current=new Map(),seen=new Set(),directories=new Set([root,meta]);let files=0;
  async function walk(relative=''){
   const full=join(root,relative);attach(full,relative);directories.add(full);
   for(const entry of await readdir(full,{withFileTypes:true})){
    const path=relative?relative+'/'+entry.name:entry.name;if(!safe(path)||!selected(path)&&!ancestor(path))continue;
    if(++entries>200000)throw Error('Watcher metadata inspection exceeds 200,000 entries');
    let info;try{info=await lstat(join(root,path),{bigint:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(info.isDirectory()&&!info.isSymbolicLink()){await walk(path);continue;}
    if(!selected(path))continue;if(++files>10000)throw Error('Watch exceeds 10,000 selected files');seen.add(path);
    if(!info.isFile()||info.isSymbolicLink()){current.set(path,{path,status:'unsupported'});continue;}
    const tracked=manifest.files[path];if(!tracked){current.set(path,{path,status:'untracked'});continue;}
    const oid=await identity(path,info),mode=info.mode&0o111n?'100755':'100644';if(oid!==tracked.oid||mode!==tracked.mode)current.set(path,{path,status:'modified',oid,mode});
   }
  }
  await walk();for(const [path,tracked]of Object.entries(manifest.files))if(!seen.has(path)&&tracked.oid!==null)current.set(path,{path,status:'deleted'});
  for(const [path,handle]of watches)if(!directories.has(path)){handle.close();watches.delete(path);}
  if(!initial)for(const path of new Set([...changes.keys(),...current.keys()])){const before=changes.get(path),after=current.get(path);if(JSON.stringify(before)!==JSON.stringify(after))emit({event:'change',...(after??{path,status:'clean'})});}
  changes=current;
 }
 try{
  attach(meta,'',true);if(await readFile(manifestPath,'utf8')!==manifestText)throw Error('Working-copy base changed during startup; restart the watcher');deadline=setTimeout(()=>stop('time-limit'),options.seconds*1000);
  await scan(true);if(!closed)emit({event:'ready',project:manifest.project,base:manifest.ref,trackedFiles:Object.keys(manifest.files).length,watchedDirectories:watches.size,changes:[...changes.values()]});
  await ended;await tail;if(!failure){if(await readFile(manifestPath,'utf8')!==manifestText)throw Error('Working-copy base changed; restart the watcher');await scan(false);}
 }catch(error){stop('rescan-required',error);reason='rescan-required';failure??=error;}
 finally{stop(reason);}
 const result={event:'stopped',reason,complete:!failure,networkRequests:0,nativeEvents:events,hashedBytes,metadataEntries:entries,peakWatchedDirectories:peakWatches,changes:[...changes.values()],...(failure?{message:failure.message}:{})};emit(result);if(failure)process.exitCode=2;
}

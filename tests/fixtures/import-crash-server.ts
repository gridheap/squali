import {startLocal} from '../../scripts/local.ts';
const server=await startLocal({...JSON.parse(process.env.SQUALI_FIXTURE_CONFIG!),port:0,test:true,directory:process.env.SQUALI_FIXTURE_DIR,onImportPushed:process.env.SQUALI_PAUSE_IMPORT==='1'?async()=>{process.send?.({type:'pushed'});await new Promise(()=>{});}:undefined});
process.send?.({type:'ready',url:server.url,dir:server.dir});
process.on('SIGTERM',async()=>{await server.close();process.exit(0);});

import {startLocal} from '../../scripts/local.ts';
const server=await startLocal({port:0,test:true,directory:process.argv[2],onPublicationPushed:process.argv[3]==='pause'?async()=>{process.send?.({phase:'pushed'});await new Promise<void>(()=>{});}:undefined});
process.send?.({phase:'ready',url:server.url});
process.on('SIGTERM',async()=>{await server.close();process.exit(0);});

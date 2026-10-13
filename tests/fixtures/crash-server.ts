import {startLocal} from '../../scripts/local.ts';
const server=await startLocal({port:0,test:true,failPublicationBeforePushOnce:process.argv[3].startsWith('pause-cancel'),adminId:process.argv[3]==='resume-other'?'replacement-reviewer':'reviewer',onPublicationBeforePush:['pause-before','pause-cancel-before'].includes(process.argv[3])?async()=>{process.send?.({phase:'before-push'});await new Promise<void>(()=>{});}:undefined,directory:process.argv[2],onPublicationPushed:['pause','pause-cancel-after'].includes(process.argv[3])?async()=>{process.send?.({phase:'pushed'});await new Promise<void>(()=>{});}:undefined});
process.send?.({phase:'ready',url:server.url});
process.on('SIGTERM',async()=>{await server.close();process.exit(0);});

import {startLocal} from './local.ts';
const server=await startLocal({port:Number(process.env.PORT??8787)});
console.log(`Weave local: ${server.url}\nLocal fixture only. Reviewer token: local-admin-test-token; agent token: local-agent-test-token`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{await server.close();process.exit(0);});

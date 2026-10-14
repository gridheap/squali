// Real development entry point acceptance. Local fixture credentials only.
import assert from 'node:assert/strict';
const origin=process.env.SQUALI_URL??'http://127.0.0.1:8797';
assert.equal(new URL(origin).hostname,'127.0.0.1','This check is local only');
const project='dev-source-'+Date.now();
const response=await fetch(origin+'/api/projects',{method:'POST',headers:{authorization:'Bearer local-admin-test-token','content-type':'application/json'},body:JSON.stringify({id:project,name:'Local source default acceptance',files:[{path:'README.md',content:'Canonical source development\n'}]})});
const result=await response.json();assert.equal(response.status,201,JSON.stringify(result));assert.equal(result.storage,'source','pnpm dev must expose the production source architecture');
console.log(JSON.stringify({command:'PORT=8797 pnpm dev; SQUALI_URL='+origin+' node scripts/check-dev-default.mjs',project,storage:result.storage,state:result.state,head:result.head}));

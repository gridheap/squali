import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const url=process.env.SQUALI_URL??'https://squa.li';
const access=JSON.parse(await readFile(process.env.SQUALI_ACCESS_FILE,'utf8'));
const evidence=process.env.SQUALI_EVIDENCE??'work/production';
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.SQUALI_BROWSER??(process.platform==='darwin'?'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser':'/usr/bin/google-chrome'),headless:true,args:process.env.SQUALI_RESOLVE_IP?[`--host-resolver-rules=MAP ${new URL(url).hostname} ${process.env.SQUALI_RESOLVE_IP}`]:[]});
const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();
const errors=[],requests=[];let apiRequests=0;
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).hostname+new URL(r.url()).pathname));
await page.route(url+'/api/**',async route=>{if(++apiRequests>20||route.request().method()!=='GET')throw new Error('Read-only verification request budget exceeded');await route.continue();});
try{
 const start=Date.now();const response=await page.goto(url,{waitUntil:'domcontentloaded'});assert.equal(response.status(),200);assert.match(await page.title(),/Squali/);
 const input=page.getByLabel('Access token');await input.waitFor({state:'visible'});const inputReadyMs=Date.now()-start;
 const usage=()=>page.evaluate(async token=>{const r=await fetch('/api/usage',{headers:{authorization:'Bearer '+token}});if(!r.ok)throw new Error('Usage check failed');return r.json();},access.reader);
 const before=await usage();assert.ok(before.attempts<250);
 await input.fill(access.reader);await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected as reader',{exact:true}).waitFor();
 await page.getByLabel('Current workspace').selectOption('demo');await page.getByRole('heading',{name:'Weave Cloud Demo',exact:true}).waitFor();
 const readyMs=Date.now()-start;await page.evaluate('window.weaveFontReady');assert.equal(await page.locator('html').getAttribute('class'),'wf-active');
 const client=await context.newCDPSession(page);await client.send('DOM.enable');await client.send('CSS.enable');const {root}=await client.send('DOM.getDocument');const fonts={};
 for(const [name,selector]of [['latin','#font-latin'],['cjk','#font-cjk']]){const {nodeId}=await client.send('DOM.querySelector',{nodeId:root.nodeId,selector});fonts[name]=(await client.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;}
 assert.ok(fonts.latin.some(f=>f.isCustomFont&&f.familyName.includes('Proxima')));assert.ok(fonts.cjk.some(f=>!f.isCustomFont&&f.familyName.includes('PingFang')));
 await page.getByLabel('Filter changes').selectOption('all');await page.screenshot({path:evidence+'/desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Source',exact:true}).click();await page.getByRole('button',{name:/README.md/}).waitFor();
 await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('heading',{name:'Published batches'}).waitFor();
 await page.getByRole('button',{name:'Cost & limits',exact:true}).click();await page.getByRole('heading',{name:'Cost & limits',exact:true}).waitFor();
 assert.equal(await page.locator('link[data-adobe-fonts]').count(),1);assert.equal(requests.filter(x=>x==='use.typekit.net/ggy5hcn.css').length,1);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const after=await usage();assert.ok(after.attempts<=250);assert.deepEqual(errors,[]);
 const report={command:(process.env.SQUALI_RESOLVE_IP?'SQUALI_RESOLVE_IP='+process.env.SQUALI_RESOLVE_IP+' ':'')+'SQUALI_ACCESS_FILE=<private-access-json> node scripts/verify-domain.mjs',url,verified:new Date().toISOString(),inputReadyMs,connectedReadyMs:readyMs,fonts,apiRequests,applicationReservedCalls:after.attempts-before.attempts,totalMonthlyReservations:after.attempts,cap:after.cap,dnsOverride:process.env.SQUALI_RESOLVE_IP??null,errors,readOnly:true};
 await writeFile(evidence+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}

import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const evidence=process.env.WEAVE_UI_EVIDENCE??'work/ui-evidence';

test('reviewer completes the browser workflow and Adobe resolves Latin and CJK glyphs',async({page,request})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const started=Date.now();
 await page.goto('/');await expect(page).toHaveTitle(/Squali/);
 await expect(page.getByRole('link',{name:'Squali home'})).toBeVisible();
 await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();
 await expect(page.getByText('Connected as reviewer')).toBeVisible();const ready=Date.now()-started;
 await page.getByRole('button',{name:'New workspace',exact:true}).click();const id='browser-'+Date.now();
 await page.getByLabel('Workspace ID').fill(id);await page.getByLabel('Workspace name').fill('Orbital SDK');await page.getByRole('button',{name:'Create workspace',exact:true}).click();await expect(page.getByText('Workspace created',{exact:true})).toBeVisible();await expect(page.getByLabel('Current workspace')).toHaveValue(id);
 await expect(page.getByRole('heading',{name:'Orbital SDK',exact:true})).toBeVisible();
 const headers={authorization:'Bearer local-agent-test-token'};
 for(const [cid,path] of [['docs','docs/quickstart.md'],['api','src/client.ts']]){
  const r=await request.post(`/api/projects/${id}/changes`,{headers,data:{id:cid,title:cid==='docs'?'Document the quickstart':'Add retry-aware client',intent:'Make the SDK easier for agents to use',context:{prompt:'Preserve existing exports',evidence:[{command:'node --test',result:'pass'}]},files:[{path,content:cid==='docs'?'# Getting started\nRead only what you need.\n':'export const retries = 3;\n'}]}});expect(r.status()).toBe(201);
 }
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Document the quickstart',exact:true}).click();
 await expect(page.getByText('Preserve existing exports',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Approve change',exact:true}).click();
 await page.getByRole('button',{name:'Close details',exact:true}).click();await page.getByRole('button',{name:'Add retry-aware client',exact:true}).click();await page.getByRole('button',{name:'Approve change',exact:true}).click();await page.getByRole('button',{name:'Close details',exact:true}).click();
 await page.getByRole('button',{name:'Preview batch',exact:true}).click();await expect(page.getByText('Ready to publish')).toBeVisible();await page.getByRole('button',{name:'Publish batch',exact:true}).click();await expect(page.getByText('Published 2 changes')).toBeVisible();
 await expect(page.locator('html')).toHaveClass(/wf-active/);await expect(page.locator('link[data-adobe-fonts]')).toHaveCount(1);
 const client=await page.context().newCDPSession(page);await client.send('DOM.enable');await client.send('CSS.enable');const {root}=await client.send('DOM.getDocument');
 const fonts:Record<string,unknown>={};for(const [name,selector]of [['latin','#font-latin'],['cjk','#font-cjk']]){const {nodeId}=await client.send('DOM.querySelector',{nodeId:root.nodeId,selector});fonts[name]=(await client.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;}
 expect(JSON.stringify(fonts.latin)).toContain('Proxima');expect(JSON.stringify(fonts.cjk)).toContain('PingFang');
 await page.getByLabel('Filter changes').selectOption('all');await mkdir(evidence,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:evidence+'/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/mobile.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 await writeFile(evidence+'/runtime.json',JSON.stringify({command:'pnpm test:ui',readyMs:ready,totalMs:Date.now()-started,fonts,errors},null,2));
});

test('font CSS timeout preserves usable inputs and locks the fallback across navigation',async({page})=>{
 await page.route('https://use.typekit.net/**',async route=>{await new Promise(r=>setTimeout(r,4000));await route.abort();});
 await page.goto('/');await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();
 await expect(page.getByText('Connected as reviewer')).toBeVisible();await expect(page.locator('html')).toHaveClass(/wf-inactive/);
 await expect(page.locator('link[data-adobe-fonts]')).toHaveCount(0);await page.getByRole('button',{name:'Cost & limits',exact:true}).click();await expect(page.getByRole('heading',{name:'Cost & limits',exact:true})).toBeVisible();
 await page.waitForTimeout(1600);await expect(page.locator('html')).toHaveClass(/wf-inactive/);await expect(page.locator('link[data-adobe-fonts]')).toHaveCount(0);
});

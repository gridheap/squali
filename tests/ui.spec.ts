import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const evidence=process.env.WEAVE_UI_EVIDENCE??'work/ui-evidence';

test('five-shark brand uses squa.li and stays inside desktop and mobile navigation',async({page})=>{
 await page.route('https://use.typekit.net/**',route=>route.abort());
 await page.goto('/');const brand=page.getByRole('link',{name:'Squali home',exact:true});
 await expect(brand).toHaveText('squa.li');
 const mark=brand.locator('img');await expect(mark).toHaveAttribute('src','/squali-five-sharks.png');
 await expect.poll(()=>mark.evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
 await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href','/squali-five-sharks.png');
 await expect(page.locator('html')).toHaveClass(/wf-inactive/);
 await mkdir(evidence,{recursive:true});
 for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:960});
  const bounds=await brand.evaluate(el=>{const b=el.getBoundingClientRect(),s=el.closest('aside')!.getBoundingClientRect(),image=el.querySelector('img')!.getBoundingClientRect();return{right:b.right,parentRight:s.right,imageWidth:image.width,overflow:document.documentElement.scrollWidth>innerWidth};});
  expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight);expect(bounds.imageWidth).toBeGreaterThanOrEqual(36);expect(bounds.overflow).toBe(false);
  await page.screenshot({path:evidence+`/brand-${width}.png`,fullPage:true});
 }
});

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
 const coldFont=await page.evaluate(()=>(window as any).weaveFontTiming);let fontNavigation='cold';if(coldFont?.state!=='active'){fontNavigation='warm';await page.reload();await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected as reviewer').waitFor();await page.getByLabel('Current workspace').selectOption(id);}
 await expect(page.locator('html')).toHaveClass(/wf-active/);await expect(page.locator('link[data-adobe-fonts]')).toHaveCount(1);
 const client=await page.context().newCDPSession(page);await client.send('DOM.enable');await client.send('CSS.enable');const {root}=await client.send('DOM.getDocument');
 const fonts:Record<string,unknown>={};for(const [name,selector]of [['latin','#font-latin'],['cjk','#font-cjk']]){const {nodeId}=await client.send('DOM.querySelector',{nodeId:root.nodeId,selector});fonts[name]=(await client.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;}
 expect(JSON.stringify(fonts.latin)).toContain('Proxima');expect(JSON.stringify(fonts.cjk)).toMatch(process.platform==='darwin'?/PingFang/:/Noto.*CJK|Source Han|Microsoft YaHei|Yu Gothic|Malgun|WenQuanYi/);expect(JSON.stringify(fonts.cjk)).not.toContain('Proxima');
 await page.getByLabel('Filter changes').selectOption('all');await mkdir(evidence,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:evidence+'/desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/mobile.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 await writeFile(evidence+'/runtime.json',JSON.stringify({command:'pnpm test:ui',readyMs:ready,totalMs:Date.now()-started,coldFont,fontNavigation,fonts,errors},null,2));
});

test('font CSS timeout preserves usable inputs and locks the fallback across navigation',async({page})=>{
 await page.route('https://use.typekit.net/**',async route=>{await new Promise(r=>setTimeout(r,4000));await route.abort();});
 await page.goto('/');await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();
 await expect(page.getByText('Connected as reviewer')).toBeVisible();await expect(page.locator('html')).toHaveClass(/wf-inactive/);
 await expect(page.locator('link[data-adobe-fonts]')).toHaveCount(0);await page.getByRole('button',{name:'Cost & limits',exact:true}).click();await expect(page.getByRole('heading',{name:'Cost & limits',exact:true})).toBeVisible();
 await page.waitForTimeout(1600);await expect(page.locator('html')).toHaveClass(/wf-inactive/);await expect(page.locator('link[data-adobe-fonts]')).toHaveCount(0);
});

test('a reviewer revises every file in a proposal and sees actual reserved usage',async({page,request})=>{
 const headers={authorization:'Bearer local-admin-test-token'};const id='revision-'+Date.now();
 const call=async(path:string,data:unknown)=>{const r=await request.post('/api'+path,{headers,data});expect(r.ok()).toBe(true);return r.json();};
 await call('/projects',{id,name:'Revision workspace',files:[{path:'a.txt',content:'a0\n'},{path:'b.txt',content:'b0\n'}]});
 await call(`/projects/${id}/changes`,{id:'original',title:'Update two files',intent:'Both edits must survive revision',files:[{path:'a.txt',content:'a1\n'},{path:'b.txt',content:'b1\n'}]});
 await page.goto('/');await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected as reviewer').waitFor();await page.getByLabel('Current workspace').selectOption(id);
 await page.getByRole('button',{name:'Update two files',exact:true}).click();await page.getByRole('button',{name:'Revise change',exact:true}).click();
 await page.getByLabel('Change ID',{exact:true}).fill('revised');
 await expect(page.getByLabel('File path 2',{exact:true})).toHaveValue('b.txt');
 await page.getByLabel('File content 1',{exact:true}).fill('a2\n');await page.getByLabel('Resolution note',{exact:true}).fill('Revise A while retaining B');
 await page.setViewportSize({width:390,height:844});await mkdir(evidence,{recursive:true});await page.screenshot({path:evidence+'/multi-file-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Submit change',exact:true}).click();await page.getByText('Change submitted for review',{exact:true}).waitFor();
 const detail=await request.get(`/api/projects/${id}/changes/revised`,{headers}).then(r=>r.json());
 expect(detail.diff.map((f:any)=>[f.path,f.after])).toEqual([['a.txt','a2\n'],['b.txt','b1\n']]);expect(detail.status).toBe('proposed');
 const usage=await request.get('/api/usage',{headers}).then(r=>r.json());
 await page.getByRole('button',{name:'Cost & limits',exact:true}).click();await expect(page.getByTestId('usage-attempts')).toHaveText(usage.attempts.toLocaleString());await expect(page.getByTestId('usage-cap')).toHaveText(usage.cap.toLocaleString());
 await mkdir(evidence,{recursive:true});await page.screenshot({path:evidence+'/revision-usage.png',fullPage:true});
});

test('reviewer selects a publication subset and inspects source history and blame',async({page,request})=>{
 const headers={authorization:'Bearer local-admin-test-token'},id='surface-'+Date.now();
 const post=async(path:string,data:unknown)=>{const response=await request.post('/api'+path,{headers,data});expect(response.ok()).toBe(true);return response.json();};
 await post('/projects',{id,name:'Source service',files:[{path:'docs/guide.md',content:'Start\n'},{path:'other.txt',content:'Keep\n'}]});
 for(const [cid,path]of [['guide','docs/guide.md'],['other','other.txt']]){await post(`/projects/${id}/changes`,{id:cid,title:cid,intent:'Review selected work',files:[{path,content:'Changed\n'}]});await post(`/projects/${id}/changes/${cid}/review`,{decision:'approved'});}
 await page.goto('/');await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected as reviewer').waitFor();await page.getByLabel('Current workspace').selectOption(id);
 await page.getByRole('checkbox',{name:'Include other',exact:true}).uncheck();await page.getByRole('button',{name:'Preview batch',exact:true}).click();await expect(page.getByText('Ready to publish',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Publish batch',exact:true}).click();await expect(page.getByText(/Published 1 changes/)).toBeVisible();
 const remaining=await request.get(`/api/projects/${id}/changes/other`,{headers}).then(r=>r.json());expect(remaining.status).toBe('approved');
 await page.getByRole('button',{name:'Source',exact:true}).click();await page.getByLabel('Search repository paths',{exact:true}).fill('guide');await page.getByRole('button',{name:'Find paths',exact:true}).click();await page.getByRole('button',{name:'Open docs/guide.md',exact:true}).click();
 await page.getByRole('button',{name:'Blame lines',exact:true}).click();await expect(page.getByRole('heading',{name:'Blame · docs/guide.md',exact:true})).toBeVisible();await expect(page.getByText('Changed',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Close details',exact:true}).click();
 await page.getByRole('button',{name:'Review policy',exact:true}).click();await page.getByLabel('Review rules (JSON)',{exact:true}).fill('[{"prefix":"docs","independentReview":true,"requireEvidence":true}]');await page.getByRole('button',{name:'Save review policy',exact:true}).click();await expect(page.getByText('Review policy saved',{exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await mkdir(evidence,{recursive:true});await page.screenshot({path:evidence+'/source-service-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

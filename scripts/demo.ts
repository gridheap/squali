import {startLocal} from './local.ts';
import {chromium} from '@playwright/test';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const scenes=JSON.parse(await readFile('docs/demo-timeline.json','utf8'));
const dir=process.env.WEAVE_DEMO_DIR??'work/demo';await mkdir(dir+'/frames',{recursive:true});
const server=await startLocal({port:0,test:true});
const browser=await chromium.launch({executablePath:'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,bypassCSP:true});const page=await context.newPage();
const frames:{time:number;file:string}[]=[];
async function api(path:string,body?:unknown,agent=false){const r=await fetch(server.url+'/api'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(agent?'local-agent-test-token':'local-admin-test-token'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await r.json() as any;if(!r.ok)throw new Error(JSON.stringify(value));return value;}
async function shot(scene:number,offset=0){
 await page.evaluate(({title,caption,index})=>{document.querySelector('#demo-caption')?.remove();const node=document.createElement('div');node.id='demo-caption';Object.assign(node.style,{position:'fixed',bottom:'0',left:'0',right:'0',zIndex:'99999',background:'#143e31',color:'white',padding:'16px 30px',boxShadow:'0 -1px 0 #264d40',fontFamily:'proxima-nova,system-ui'});const titleNode=document.createElement('div');titleNode.textContent=title;Object.assign(titleNode.style,{fontSize:'19px',fontWeight:'600'});const captionNode=document.createElement('div');captionNode.textContent=caption;Object.assign(captionNode.style,{fontSize:'13px',opacity:'.8',marginTop:'4px'});node.appendChild(titleNode);node.appendChild(captionNode);document.body.appendChild(node);window.scrollTo(0,0);},{title:scenes[scene].title,caption:scenes[scene].caption,index:scene});
 await page.waitForTimeout(150);const file=`frames/${scene}-${offset}.png`;await page.screenshot({path:dir+'/'+file});frames.push({time:scenes[scene].start+offset,file});
}
try{
 await api('/projects',{id:'orbital',name:'Orbital SDK',files:[{path:'README.md',content:'# Orbital SDK\n\nAn SDK built by agents, reviewed together.\n'},{path:'src/config.ts',content:'export const retries = 1;\n\nexport const timeout = 1000;\n'}]});
 await page.goto(server.url);await page.getByLabel('Access token').fill('local-admin-test-token');await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected as reviewer').waitFor();await page.evaluate('window.weaveFontReady');await shot(0);
 await page.getByRole('button',{name:'Source',exact:true}).click();await page.getByRole('heading',{name:'Source / /'}).waitFor();await shot(1);
 await page.getByRole('button',{name:/README.md/}).click();await page.locator('#dialog').waitFor({state:'visible'});await shot(1,20);await page.getByRole('button',{name:'Close details'}).click();
 const base=(await api('/projects/orbital')).head;
 for(const [id,title,path,content] of [['docs','Document the quickstart','docs/quickstart.md','# Getting started\n\nRead the paths your agent needs.\nKeep changes small and reviewable.\n'],['client','Add a retry-aware client','src/client.ts','export const retryLimit = 3;\nexport const jitter = true;\n']])await api('/projects/orbital/changes',{id,title,intent:'Make the SDK predictable for automated clients. Preserve existing exports.',base,context:{task:'SDK reliability',prompt:'Keep retry costs bounded.',evidence:{command:'pnpm test:e2e',kind:'agent-reported; reviewer must verify'}},files:[{path,content}]},true);
 await page.getByRole('button',{name:/^Changes/}).click();await page.getByRole('button',{name:'Refresh'}).click();await page.getByRole('button',{name:'Document the quickstart',exact:true}).waitFor();await shot(2);
 await page.getByRole('button',{name:'Document the quickstart',exact:true}).click();await page.getByRole('button',{name:'Approve change'}).waitFor();await shot(2,23);await shot(3);
 await page.getByRole('button',{name:'Approve change'}).click();await page.getByText('Approval recorded for this immutable version').waitFor();await page.getByRole('button',{name:'Close details'}).click();await page.getByRole('button',{name:'Add a retry-aware client',exact:true}).click();await page.getByRole('button',{name:'Approve change'}).click();await page.getByRole('button',{name:'Close details'}).click();await shot(3,24);
 await page.getByRole('button',{name:'Preview batch'}).click();await page.getByText('Ready to publish').waitFor();await shot(4);
 await page.getByRole('button',{name:'Publish batch'}).click();await page.getByText('Published 2 changes',{exact:false}).waitFor();await page.getByLabel('Filter changes').selectOption('all');await shot(4,24);
 for(const [id,n] of [['fast',2],['careful',4]])await api('/projects/orbital/changes',{id,title:`Set retry limit to ${n}`,intent:'Choose a bounded retry policy',base,context:{task:'Competing retry policies',constraint:'Preserve timeout'},files:[{path:'src/config.ts',content:`export const retries = ${n};\n\nexport const timeout = 1000;\n`}]},true);
 for(const id of ['fast','careful'])await api(`/projects/orbital/changes/${id}/review`,{decision:'approved',note:'Policy candidate'});
 await page.getByRole('button',{name:'Refresh'}).click();await page.getByRole('button',{name:'Preview batch'}).click();await page.getByText('Conflicts need a decision').waitFor();await shot(5);
 await api('/projects/orbital/changes/fast/review',{decision:'rejected',note:'Use the reviewed four-retry policy instead'});
 const resolved=await api('/projects/orbital/changes/careful/revise',{id:'retry-policy-v2',note:'Resolve the competing policy explicitly; keep timeout unchanged',files:[{path:'src/config.ts',content:'export const retries = 4;\n\nexport const timeout = 1000;\n'}]},true);
 await page.getByRole('button',{name:'Close details'}).click();await page.getByRole('button',{name:'Refresh'}).click();await page.getByRole('button',{name:'Set retry limit to 4',exact:true}).first().click();await page.getByRole('button',{name:'Approve change'}).waitFor();await shot(5,25);
 await page.getByRole('button',{name:'Close details'}).click();await page.getByRole('button',{name:'Cost & limits',exact:true}).click();await page.getByRole('heading',{name:'Cost & limits',exact:true}).waitFor();await shot(6);
 await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('heading',{name:'Published batches'}).waitFor();await shot(6,24);
 await page.getByRole('button',{name:/^Changes/}).click();await shot(7);
 await writeFile(dir+'/frames.json',JSON.stringify(frames,null,2));console.log(JSON.stringify({frames:frames.length,duration:scenes.at(-1).start+scenes.at(-1).duration,mode:'Actual local UI screenshots, edited into a narrated walkthrough'}));
}finally{await browser.close();await server.close();}

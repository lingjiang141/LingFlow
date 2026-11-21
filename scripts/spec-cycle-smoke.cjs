const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const root=process.env.LINGFLOW_SPEC_SMOKE_DIR;
if(!root)throw Error('Run node scripts/spec-cycle-smoke.mjs');
app.setPath('userData',path.join(root,'profile'));
app.whenReady().then(async()=>{
  const {Store}=await import(pathToFileURL(path.resolve('src/store.mjs')));
  const data=path.join(root,'data'),store=new Store(path.join(data,'workflow.sqlite'));
  const fixture=path.join(root,'project');fs.mkdirSync(fixture,{recursive:true});
  store.change(s=>{
    s.projects.push({id:'p',name:'规格周期总览验证',root:fixture});
    s.requirements.push({id:'r',projectId:'p',text:'首页不应出现的冗长需求正文'.repeat(100)});
    s.tasks.push(...Array.from({length:8},(_,i)=>({id:'task-'+i,projectId:'p',requirementId:'r',ticketKey:'R36-'+(i+1),
      title:'周期行为 '+(i+1),state:i<5?'accepted':i<7?'paused':'queued',risk:'low',readOnly:true,
      ...(i===5&&{releasedScope:{reason:'保留历史'}}),
      writes:[],reads:[],resources:[],dependencies:[],questions:[],reports:[],reviews:[],revision:1,acceptedAt:new Date().toISOString(),
      sources:{spec:{file:'round/spec.md',digest:i<5?'v1':i<7?'v2':'v3'}}})));
  });store.close();
  const {startServer}=await import(pathToFileURL(path.resolve('src/server.mjs')));
  const runtime=await startServer({dataDir:data,port:0});
  try{
    for (let i=0;i<5;i++) await runtime.workflow.call('ui','addRole',{projectId:'p',kind:i===0?'controller':i<3?'developer':'reviewer',name:['主控','开发一','开发二','审查一','审查二'][i]},'layout-role-'+i);
    const window=new BrowserWindow({width:1360,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true}});
    await window.loadURL(`http://127.0.0.1:${runtime.port}/#${runtime.uiToken}`);
    const execute=code=>window.webContents.executeJavaScript(code);
    const until=async code=>{for(let i=0;i<100;i++){if(await execute(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+code);};
    await until("document.querySelectorAll('#board .task').length === 8");
    const layouts=[];
    const paint=async(theme,wallpaper)=>execute(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.wallpaper=${JSON.stringify(wallpaper)};document.getElementById('window-background').style.cssText='background-image:linear-gradient(115deg,#fff 0%,#e9ab93 25%,#16295a 52%,#05111b 75%,#eee 100%);opacity:${wallpaper}';document.querySelectorAll('.role').forEach((card,i)=>{if(i>1)return;card.classList.add('has-media');const media=card.querySelector('.card-media');media.style.cssText='background-image:linear-gradient(115deg,#fff,#e9ab93 25%,#16295a 52%,#05111b 75%,#eee);opacity:1';});window.scrollTo(0,0)`);
    for (const [width,height] of [[1360,900],[1024,768],[1920,1080]]) {
      window.setContentSize(width,height);
      await until(`innerWidth===${width} && innerHeight===${height}`);
      for (const theme of ['dark','white','lavender','sky']) for (const wallpaper of ['0','1']) {
        await paint(theme,wallpaper);
        await new Promise(r=>setTimeout(r,150));
        const layout=await execute("({board:document.getElementById('board').getBoundingClientRect().height,roles:[...document.querySelectorAll('.role')].map(e=>({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),height:innerHeight,overflow:[...document.querySelectorAll('#board .task-list')].some(list=>list.scrollHeight>list.clientHeight)})");
        assert.ok(layout.board<=212,JSON.stringify(layout));
        assert.ok(layout.roles.length===5&&layout.roles[0].bottom<layout.height,'First member card must be fully visible without page scrolling: '+JSON.stringify(layout));
        assert.ok(layout.overflow,'Long ticket groups scroll inside the compact board');
        layouts.push({width,height,theme,wallpaper,...layout});
      }
    }
    window.setContentSize(1360,900);
    await until('innerWidth===1360 && innerHeight===900');
    const initial=await execute("({count:document.querySelectorAll('#board .task').length,scope:document.getElementById('spec-scope').selectedOptions[0].textContent,summary:document.getElementById('spec-summary').textContent,requirements:!!document.getElementById('requirements'),text:document.body.innerText,errors:window.lingflowErrors})");
    assert.equal(initial.count,8);assert.match(initial.scope,/本轮全部票/);assert.match(initial.summary,/3 个冻结版本/);
    assert.match(initial.summary,/已验收 5\/7 张.*历史 1 张/);
    const columns=await execute("[...document.querySelectorAll('#board .column')].map(column=>({heading:column.querySelector('h3').textContent, text:column.querySelector('.task-list').textContent,last:column.querySelector('.task:last-child')?.textContent}))");
    assert.match(columns[0].text,/R36-7/);assert.doesNotMatch(columns[0].text,/R36-6/);
    assert.match(columns[2].heading,/交付与验收 · 5 · 历史 1/);assert.match(columns[2].last,/R36-6.*范围已释放/);
    assert.equal(initial.requirements,false);assert.doesNotMatch(initial.text,/已确认需求|首页不应出现/);assert.deepEqual(initial.errors,[]);
    const key=JSON.stringify(['round/spec.md','v2']);
    await execute(`document.getElementById('spec-scope').value=${JSON.stringify(key)};document.getElementById('spec-scope').dispatchEvent(new Event('change'))`);
    await until("document.querySelectorAll('#board .task').length === 2");
    await execute("document.getElementById('spec-scope').value='current';document.getElementById('spec-scope').dispatchEvent(new Event('change'))");
    await until("document.querySelectorAll('#board .task').length === 8");
    await execute("document.querySelector('#board .task-list .task:last-child').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await until("document.getElementById('modal').open");
    assert.match(await execute("document.getElementById('modal').textContent"),/周期行为/);
    await execute("document.getElementById('modal').close()");
    assert.deepEqual(await execute('window.lingflowErrors'),[]);
    window.showInactive();await new Promise(r=>setTimeout(r,300));
    let screenshotError;
    try{for (const theme of ['dark','white']) {await paint(theme,'1');await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(root,theme==='dark'?'main-cycle.png':'main-cycle-light.png'),(await window.webContents.capturePage()).toPNG());}}catch(e){screenshotError=e.message;}
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({cycleTickets:8,versionTickets:2,requirementsHidden:true,requirementsRetained:(await runtime.workflow.snapshot()).requirements.length===1,layouts,errors:initial.errors,screenshotError}));
    window.destroy();
  }finally{await runtime.close();}
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});

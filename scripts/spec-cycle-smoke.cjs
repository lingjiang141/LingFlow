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
      title:'周期行为 '+(i+1),state:i<5?'accepted':'queued',risk:'low',readOnly:true,
      writes:[],reads:[],resources:[],dependencies:[],questions:[],
      sources:{spec:{file:'round/spec.md',digest:i<5?'v1':i<7?'v2':'v3'}}})));
  });store.close();
  const {startServer}=await import(pathToFileURL(path.resolve('src/server.mjs')));
  const runtime=await startServer({dataDir:data,port:0});
  try{
    const window=new BrowserWindow({width:1360,height:900,show:false,webPreferences:{contextIsolation:true,sandbox:true}});
    await window.loadURL(`http://127.0.0.1:${runtime.port}/#${runtime.uiToken}`);
    const execute=code=>window.webContents.executeJavaScript(code);
    const until=async code=>{for(let i=0;i<100;i++){if(await execute(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+code);};
    await until("document.querySelectorAll('#board .task').length === 8");
    const initial=await execute("({count:document.querySelectorAll('#board .task').length,scope:document.getElementById('spec-scope').selectedOptions[0].textContent,summary:document.getElementById('spec-summary').textContent,requirements:!!document.getElementById('requirements'),text:document.body.innerText,errors:window.lingflowErrors})");
    assert.equal(initial.count,8);assert.match(initial.scope,/本轮全部票/);assert.match(initial.summary,/3 个冻结版本/);
    assert.equal(initial.requirements,false);assert.doesNotMatch(initial.text,/已确认需求|首页不应出现/);assert.deepEqual(initial.errors,[]);
    const key=JSON.stringify(['round/spec.md','v2']);
    await execute(`document.getElementById('spec-scope').value=${JSON.stringify(key)};document.getElementById('spec-scope').dispatchEvent(new Event('change'))`);
    await until("document.querySelectorAll('#board .task').length === 2");
    await execute("document.getElementById('spec-scope').value='current';document.getElementById('spec-scope').dispatchEvent(new Event('change'))");
    await until("document.querySelectorAll('#board .task').length === 8");
    window.showInactive();await new Promise(r=>setTimeout(r,300));
    let screenshotError;
    try{fs.writeFileSync(path.join(root,'main-cycle.png'),(await window.webContents.capturePage()).toPNG());}catch(e){screenshotError=e.message;}
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({cycleTickets:8,versionTickets:2,requirementsHidden:true,requirementsRetained:(await runtime.workflow.snapshot()).requirements.length===1,errors:initial.errors,screenshotError}));
    window.destroy();
  }finally{await runtime.close();}
  app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});

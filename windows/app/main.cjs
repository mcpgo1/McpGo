'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow,Tray,Menu,ipcMain,safeStorage,nativeImage,shell,dialog,clipboard}=require('electron');
const {Runtime,assertTunnelId,runtimePaths,terminalEndpoint}=require('./runtime.cjs');
const {checkTunnelDoctor}=require('./wizard-doctor.cjs');
const {readSkill,textForChat}=require('./skills.cjs');
const {localRequest}=require('./local-api.cjs');
const {onboarding}=require('./onboarding.cjs');
const {record,register}=require('./diagnostics.cjs');
function diag(name,details={}){record(app.getPath('userData'),name,details)}
function importInstallerEvents(){
 try{
  const source=path.join(app.getPath('appData'),'McpGo','Onboarding','Logs','installer-events.log');
  if(!fs.existsSync(source)||fs.lstatSync(source).isSymbolicLink())return;
  const stats=fs.statSync(source);
  if(stats.size>32768){diag('windows.installer.events.oversized',{bytes:stats.size});return}
  const raw=fs.readFileSync(source,'utf8');
  const known=new Set(['nsis.init','nsis.install.files-copied']);
  for(const line of raw.split(/\r?\n/)){
   if(known.has(line.trim()))diag('windows.installer.event',{
      stage:line.trim(),sourceModifiedAt:stats.mtime.toISOString()});
  }
  fs.renameSync(source,source+'.imported');
 }catch(e){diag('windows.installer.import.failure',{errorType:e.code||e.name})}
}

const {SettingsStore,runtimeConfigChanged}=require('./settings.cjs');
const {checkUpdates,safeReleaseUrl}=require('./updates.cjs');
const {version:appVersion}=require('../package.json');
if(process.platform!=='win32')throw Error('Windows only');
app.setAppUserModelId('ru.mcpgo.desktop');
if(!app.requestSingleInstanceLock()){app.quit();process.exit(0)}
let window,tray,runtime,quitting=false;
const settings=new SettingsStore({userData:()=>app.getPath('userData'),safeStorage});
function publicStatus(){return {...settings.public(),status:runtime?.state()||{},readiness:runtime?.readinessState()||{}}}
function publish(){
 if(window&&!window.isDestroyed())window.webContents.send('mcpgo:status',publicStatus());
 if(tray)tray.setToolTip('McpGo — '+(runtime?.state()?.terminal==='running'?'работает':'подключение'));
}
function iconPath(){
 const built=path.join(process.resourcesPath,'mcpgo-runtime','native','McpGoMark.png');
 return fs.existsSync(built)?built:path.resolve(__dirname,'../../native/McpGoMark.png');
}
function openWindow(){
 diag('windows.ui.openWindow');
 if(window&&!window.isDestroyed()){window.show();window.focus();return}
 window=new BrowserWindow({width:1100,height:770,minWidth:770,minHeight:620,show:false,
 title:'McpGo для Windows',icon:iconPath(),backgroundColor:'#0d1016',autoHideMenuBar:true,
 webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,
 contextIsolation:true,sandbox:true,webSecurity:true}});
 window.loadFile(path.join(__dirname,'index.html'));
 window.once('ready-to-show',()=>window.show());
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',event=>event.preventDefault());
 window.on('close',event=>{if(!quitting){event.preventDefault();window.hide()}});
}
ipcMain.handle('mcpgo:status',()=>publicStatus());
const guideLinks=Object.freeze({chrome:'https://www.google.com/chrome/',organization:'https://platform.openai.com/settings/organization/general',workspace:'https://chatgpt.com/#settings',admin:'https://platform.openai.com/settings/organization/admin-keys',roles:'https://platform.openai.com/settings/organization/people/roles',tunnels:'https://platform.openai.com/settings/organization/tunnels','api-keys':'https://platform.openai.com/settings/organization/api-keys',plugins:'https://chatgpt.com/plugins'});
ipcMain.handle('mcpgo:guide-link',(_event,kind)=>{
 if(!Object.hasOwn(guideLinks,kind))throw Error('INVALID_GUIDE_LINK');
 return shell.openExternal(guideLinks[kind]);
});
ipcMain.handle('mcpgo:copy-tunnel',(_event,name)=>{
 if(!['terminal','browser'].includes(name))throw Error('INVALID_TUNNEL_NAME');
 const current=publicStatus();
 clipboard.writeText(assertTunnelId(name==='terminal'?current.terminal?.id:current.browserTunnel?.id));
 return true;
});
ipcMain.handle('mcpgo:copy-connection-test',()=>{
 clipboard.writeText('Проверь McpGo именно из этого чата: вызови Terminal с безвредной командой echo MCPGO_OK и Playwright: сначала mcpgo_workspace, затем browser_tabs(action=list) с возвращённым workspace_id. Не открывай и не закрывай вкладки. Сообщи отдельно, какие вызовы реально прошли, какие отсутствуют или завершились ошибкой. Не заменяй проверку предположением.');
 return true;
});
ipcMain.handle('mcpgo:verify-connection',async()=>{await runtime.verifyBrowserConnection(true);return publicStatus()});
ipcMain.handle('mcpgo:recover-tunnel',async(_event,name)=>{
 await settingsSaveTail;
 if(!await runtime.recoverTunnel(name,{manual:true}))throw Error('Туннель не готов к безопасному переподключению. Проверь локальный MCP и авторизацию.');
 return publicStatus();
});
let settingsSaveTail=Promise.resolve();
ipcMain.handle('mcpgo:save',(_event,value)=>{
 const action=settingsSaveTail.then(async()=>{

 register(value);diag('windows.settings.save.requested',{keys:Object.keys(value||{})});
 const before=settings.load();
 const rawToken=value?.playwrightExtension?.token;
 if(typeof rawToken==='string'&&rawToken.trim()){
  const token=rawToken.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/,'');
  try{
   const browser=value.browser||runtime.browser;
   // Avoid a second competing extension session for the same saved credential.
   const existing=await settings.extensionToken().catch(()=>null);
   const live=existing?.token===token&&browser===runtime.browser&&await runtime.verifyBrowserConnection(true);
   if(!live)await runtime.verifyExtension(token,browser);
   else {
    diag('windows.extension.trial.reused',{browser});
    if(value.playwrightExtension.remove!==true)value={...value,playwrightExtension:undefined};
   }
  }catch(e){diag('windows.extension.trial.failed',{code:e.message});throw e}
 }
 const v=await settings.save(value);
 app.setLoginItemSettings({openAtLogin:v.autoStart});
 const restartNeeded=!runtime.running||runtimeConfigChanged(before,settings.load());
 runtime.browser=v.browser;
 if(restartNeeded)await runtime.restart();
 publish();diag('windows.settings.save.success',{restartNeeded});return publicStatus();
 });
 settingsSaveTail=action.catch(()=>{});
 return action;
});
ipcMain.handle('mcpgo:restart',async()=>{await settingsSaveTail;diag('windows.runtime.restart.requested');await runtime.restart();publish();return publicStatus()});
ipcMain.handle('mcpgo:check-updates',()=>checkUpdates(appVersion));
ipcMain.handle('mcpgo:open-update',(_event,url)=>shell.openExternal(safeReleaseUrl(url)));
ipcMain.handle('mcpgo:open-releases',()=>shell.openExternal('https://github.com/mcpgo1/McpGo/releases'));
// Fixed allowlist: never accept filesystem paths or arbitrary URLs from the renderer.
ipcMain.handle('mcpgo:skill-read',(_event,id)=>{
 const {content}=readSkill(runtime.resourceRoot,id);
 return {id,content};
});
ipcMain.handle('mcpgo:skill-copy',(_event,id,mode)=>{
 if(mode!=='chat'&&mode!=='raw')throw Error('INVALID_SKILL_COPY_MODE');
 const {content}=readSkill(runtime.resourceRoot,id);
 clipboard.writeText(mode==='chat'?textForChat(content):content);
 return {ok:true};
});
ipcMain.handle('mcpgo:skill-open',(_event,id)=>{
 const {file}=readSkill(runtime.resourceRoot,id);
 shell.showItemInFolder(file);
 return {ok:true};
});
ipcMain.handle('mcpgo:open-location',async(_event,kind)=>{
 if(kind==='docs')return shell.openExternal('https://github.com/mcpgo1/McpGo/blob/main/README.md');
 if(kind!=='folder'&&kind!=='logs')throw Error('INVALID_LOCATION');
 const target=kind==='folder'?runtime.resourceRoot:path.join(app.getPath('userData'),'Onboarding','Logs');
 if(kind==='logs')fs.mkdirSync(target,{recursive:true});
 const error=await shell.openPath(target);
 if(error)throw Error('OPEN_LOCATION_FAILED: '+error);
 return {ok:true};
});


ipcMain.handle('mcpgo:service-read',(_event,service,route)=>localRequest(service,route,undefined,app.getPath('userData')));
ipcMain.handle('mcpgo:service-action',(_event,service,route,body)=>localRequest(service,route,body,app.getPath('userData')));
ipcMain.handle('mcpgo:onboard',(_event,action,payload)=>{
 const run=settingsSaveTail.then(async()=>{
 register(payload);diag('windows.ui.onboard.requested',{action,keys:Object.keys(payload||{})});
 if(!['status','connection-preflight','browser-check','provision','runtime-auto','runtime-projects','discover','runtime-inspect','runtime-recover-key','verify-remote','import','doctor','chatgpt-instructions','dismiss'].includes(action))
  throw Error('UNSUPPORTED_ONBOARDING_ACTION');
 if(['provision','runtime-auto','runtime-recover-key','import','chatgpt-instructions','dismiss'].includes(action)&&payload?.confirmed!==true)
  throw Error('EXPLICIT_CONFIRMATION_REQUIRED');
 const root=runtime.resourceRoot;
 let terminal,browser;
 if(['runtime-auto','runtime-recover-key'].includes(action)){
  // Validate both IDs and the local encryption backend BEFORE issuing the
  // one-time, non-idempotent runtime credential.
  await settings.cryptoReady();
  const filename=path.join(app.getPath('userData'),'Onboarding','state.json');
  if(fs.lstatSync(filename).isSymbolicLink())throw Error('UNSAFE_ONBOARDING_STATE');
  const local=JSON.parse(fs.readFileSync(filename,'utf8'));
  terminal=assertTunnelId(local.tunnels?.terminal?.id);
  browser=assertTunnelId(local.tunnels?.browser?.id);
  if(terminal===browser)throw Error('DUPLICATE_TUNNEL_ID');
 }
 if(action==='doctor'){
  const paths=runtimePaths(root,app.getPath('userData'));
  const checks={};
  for(const name of ['terminal','browser']){
   try{
    const credential=await settings.credential(name==='terminal'?'terminal':'browserTunnel');
    const url=name==='terminal'?terminalEndpoint(paths.config):'http://127.0.0.1:8940/mcp';
    checks[name]=await checkTunnelDoctor({client:paths.tunnelClient,credential,url});
   }catch{checks[name]={ready:false,reason:'Локальная конфигурация или ключ недоступны.'}}
  }
  return {checks,note:'Doctor проверяет транспорт, а не вызов плагина ChatGPT.'};
 }
 const result=await onboarding({action,payload,root,userData:app.getPath('userData'),
  python:path.join(root,'python','python.exe')});
 if(action==='connection-preflight'){
  try{await settings.cryptoReady();result.secureStorage=true}
  catch{result.secureStorage=false}
 }
 diag('windows.ui.onboard.response',{action,result});
 if(['runtime-auto','runtime-recover-key'].includes(action)){
  if(typeof result?.runtimeKey!=='string'||!result.runtimeKey.startsWith('sk-'))
   throw Error('RUNTIME_KEY_MISSING');
  await settings.save({terminal:{id:terminal,key:result.runtimeKey},
    browserTunnel:{id:browser,key:result.runtimeKey}});
  let remoteVerified=false;
  try{
   const verification=await onboarding({action:'verify-remote',payload:{runtimeKey:result.runtimeKey},root,
    userData:app.getPath('userData'),python:path.join(root,'python','python.exe')});
   remoteVerified=verification.verified?.terminal===true&&verification.verified?.browser===true;
  }catch{diag('windows.onboarding.remote_verification_failed')}
  await runtime.restart();publish();
  return {ok:true,configured:true,remoteVerified};
 }
 return result;
 });
 settingsSaveTail=run.catch(()=>{});
 return run;
});
ipcMain.handle('mcpgo:export-diagnostics',async()=>{
 diag('windows.ui.export.clicked');
 const selected=await dialog.showSaveDialog(window||undefined,{
  title:'Экспортировать диагностику первого подключения',
  defaultPath:'mcpgo-onboarding-diagnostics-'+new Date().toISOString().slice(0,10)+'.zip',
  filters:[{name:'ZIP diagnostics',extensions:['zip']}],
 });
 if(selected.canceled||!selected.filePath)return {canceled:true};
 const result=await onboarding({action:'export-diagnostics',payload:{destination:selected.filePath},
   root:runtime.resourceRoot,userData:app.getPath('userData'),
   python:path.join(runtime.resourceRoot,'python','python.exe')});
 diag('windows.ui.export.finished',{fileName:path.basename(selected.filePath)});
 return result;
});
ipcMain.handle('mcpgo:extension-store',()=>shell.openExternal('https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm'));
ipcMain.handle('mcpgo:browser-update',(_event,browser)=>{
 const urls={chrome:'https://www.google.com/chrome/',msedge:'https://www.microsoft.com/edge'};
 if(!Object.hasOwn(urls,browser))throw Error('INVALID_BROWSER');
 return shell.openExternal(urls[browser]);
});
app.on('second-instance',openWindow);
app.on('window-all-closed',()=>{}); // Closing the window keeps the tray agent alive.
app.on('before-quit',()=>{diag('windows.app.beforeQuit');quitting=true;runtime?.stop()});
app.whenReady().then(async()=>{
 importInstallerEvents();
 diag('windows.app.ready',{version:appVersion,platform:process.platform,arch:process.arch,appPath:app.getAppPath(),userData:app.getPath('userData'),packaged:app.isPackaged});
 const root=app.isPackaged?path.join(process.resourcesPath,'mcpgo-runtime'):path.resolve(__dirname,'../..');
 runtime=new Runtime({resourceRoot:root,userData:app.getPath('userData'),
 nodeExecutable:app.isPackaged?path.join(root,'node','node.exe'):
   path.join(root,'windows','vendor','node','node.exe'),browser:settings.public().browser,
 credentials:target=>target==='playwrightExtension'?settings.extensionToken():
  settings.credential(target==='browser'?'browserTunnel':'terminal'),onChange:publish});
 openWindow();
 tray=new Tray(nativeImage.createFromPath(iconPath()).resize({width:16,height:16}));
 tray.setContextMenu(Menu.buildFromTemplate([
 {label:'Открыть McpGo',click:openWindow},
 {label:'Перезапустить',click:async()=>{await settingsSaveTail;await runtime.restart()}},
 {type:'separator'},{label:'Выход',click:()=>{quitting=true;app.quit()}}
 ]));
 tray.on('double-click',openWindow);
 diag('windows.runtime.start.requested');await runtime.start();publish();diag('windows.runtime.start.complete',{state:runtime.state()});
}).catch(e=>{diag('windows.app.startup.failure',{errorType:e?.name,error:e?.message,stack:e?.stack});console.error('Startup error:',e.message);app.quit()});

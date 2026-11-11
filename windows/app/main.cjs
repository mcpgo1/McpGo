'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow,Tray,Menu,ipcMain,safeStorage,nativeImage,shell}=require('electron');
const {Runtime,assertTunnelId}=require('./runtime.cjs');
const {localRequest}=require('./local-api.cjs');
const {onboarding}=require('./onboarding.cjs');
const {SettingsStore}=require('./settings.cjs');
const {checkUpdates,safeReleaseUrl}=require('./updates.cjs');
const {version:appVersion}=require('../package.json');
if(process.platform!=='win32')throw Error('Windows only');
app.setAppUserModelId('ru.mcpgo.desktop');
if(!app.requestSingleInstanceLock()){app.quit();process.exit(0)}
let window,tray,runtime,quitting=false;
const settings=new SettingsStore({userData:()=>app.getPath('userData'),safeStorage});
function publicStatus(){return {...settings.public(),status:runtime?.state()||{}}}
function publish(){
 if(window&&!window.isDestroyed())window.webContents.send('mcpgo:status',publicStatus());
 if(tray)tray.setToolTip('McpGo — '+(runtime?.state()?.terminal==='running'?'работает':'подключение'));
}
function iconPath(){
 const built=path.join(process.resourcesPath,'mcpgo-runtime','native','McpGoMark.png');
 return fs.existsSync(built)?built:path.resolve(__dirname,'../../native/McpGoMark.png');
}
function openWindow(){
 if(window&&!window.isDestroyed()){window.show();window.focus();return}
 window=new BrowserWindow({width:900,height:690,minWidth:730,minHeight:590,show:false,
 title:'McpGo для Windows',icon:iconPath(),backgroundColor:'#121719',autoHideMenuBar:true,
 webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,
 contextIsolation:true,sandbox:true,webSecurity:true}});
 window.loadFile(path.join(__dirname,'index.html'));
 window.once('ready-to-show',()=>window.show());
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',event=>event.preventDefault());
 window.on('close',event=>{if(!quitting){event.preventDefault();window.hide()}});
}
ipcMain.handle('mcpgo:status',()=>publicStatus());
ipcMain.handle('mcpgo:save',async(_event,value)=>{
 const v=await settings.save(value);
 app.setLoginItemSettings({openAtLogin:v.autoStart});
 runtime.browser=v.browser;await runtime.restart();publish();return publicStatus();
});
ipcMain.handle('mcpgo:restart',async()=>{await runtime.restart();publish();return publicStatus()});
ipcMain.handle('mcpgo:check-updates',()=>checkUpdates(appVersion));
ipcMain.handle('mcpgo:open-update',(_event,url)=>shell.openExternal(safeReleaseUrl(url)));
ipcMain.handle('mcpgo:open-releases',()=>shell.openExternal('https://github.com/mcpgo1/McpGo/releases'));

ipcMain.handle('mcpgo:service-read',(_event,service,route)=>localRequest(service,route));
ipcMain.handle('mcpgo:service-action',(_event,service,route,body)=>localRequest(service,route,body));
ipcMain.handle('mcpgo:onboard',async(_event,action,payload)=>{
 if(!['provision','runtime-auto','runtime-projects','discover','runtime-inspect','verify-remote'].includes(action))
  throw Error('UNSUPPORTED_ONBOARDING_ACTION');
 if((action==='provision'||action==='runtime-auto')&&payload?.confirmed!==true)
  throw Error('EXPLICIT_CONFIRMATION_REQUIRED');
 const root=runtime.resourceRoot;
 let terminal,browser;
 if(action==='runtime-auto'){
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
 const result=await onboarding({action,payload,root,userData:app.getPath('userData'),
  python:path.join(root,'python','python.exe')});
 if(action==='runtime-auto'){
  if(typeof result?.runtimeKey!=='string'||!result.runtimeKey.startsWith('sk-'))
   throw Error('RUNTIME_KEY_MISSING');
  await settings.save({terminal:{id:terminal,key:result.runtimeKey},
    browserTunnel:{id:browser,key:result.runtimeKey}});
  await runtime.restart();publish();
  return {ok:true,configured:true};
 }
 return result;
});
ipcMain.handle('mcpgo:docs',()=>shell.openExternal('https://github.com/microsoft/playwright-mcp'));
app.on('second-instance',openWindow);
app.on('window-all-closed',()=>{}); // Closing the window keeps the tray agent alive.
app.on('before-quit',()=>{quitting=true;runtime?.stop()});
app.whenReady().then(async()=>{
 const root=app.isPackaged?path.join(process.resourcesPath,'mcpgo-runtime'):path.resolve(__dirname,'../..');
 runtime=new Runtime({resourceRoot:root,userData:app.getPath('userData'),
 nodeExecutable:app.isPackaged?path.join(root,'node','node.exe'):
   path.join(root,'windows','vendor','node','node.exe'),browser:settings.public().browser,
 credentials:target=>settings.credential(target==='browser'?'browserTunnel':'terminal'),onChange:publish});
 openWindow();
 tray=new Tray(nativeImage.createFromPath(iconPath()).resize({width:16,height:16}));
 tray.setContextMenu(Menu.buildFromTemplate([
 {label:'Открыть McpGo',click:openWindow},
 {label:'Перезапустить',click:()=>runtime.restart()},
 {type:'separator'},{label:'Выход',click:()=>{quitting=true;app.quit()}}
 ]));
 tray.on('double-click',openWindow);
 await runtime.start();publish();
}).catch(e=>{console.error('Startup error:',e.message);app.quit()});

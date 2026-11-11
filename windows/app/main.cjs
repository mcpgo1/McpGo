'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,BrowserWindow,Tray,Menu,ipcMain,safeStorage,nativeImage,shell}=require('electron');
const {Runtime}=require('./runtime.cjs');
const {SettingsStore}=require('./settings.cjs');
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
ipcMain.handle('mcpgo:docs',()=>shell.openExternal('https://github.com/microsoft/playwright-mcp'));
app.on('second-instance',openWindow);
app.on('window-all-closed',()=>{}); // Closing the window keeps the tray agent alive.
app.on('before-quit',()=>{quitting=true;runtime?.stop()});
app.whenReady().then(async()=>{
 const root=app.isPackaged?path.join(process.resourcesPath,'mcpgo-runtime'):path.resolve(__dirname,'../..');
 runtime=new Runtime({resourceRoot:root,userData:app.getPath('userData'),
 nodeExecutable:process.execPath,browser:settings.public().browser,
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

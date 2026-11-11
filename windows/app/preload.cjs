'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mcpgo',Object.freeze({
 status:()=>ipcRenderer.invoke('mcpgo:status'),
 save:data=>ipcRenderer.invoke('mcpgo:save',data),
 restart:()=>ipcRenderer.invoke('mcpgo:restart'),
 docs:()=>ipcRenderer.invoke('mcpgo:docs'),
 onStatus:callback=>{
  if(typeof callback!=='function')return;
  const listener=(_event,data)=>callback(data);
  ipcRenderer.on('mcpgo:status',listener);
  return ()=>ipcRenderer.removeListener('mcpgo:status',listener);
 }
}));

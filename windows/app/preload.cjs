'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('mcpgo',Object.freeze({
 status:()=>ipcRenderer.invoke('mcpgo:status'),
 save:data=>ipcRenderer.invoke('mcpgo:save',data),
 restart:()=>ipcRenderer.invoke('mcpgo:restart'),
 docs:()=>ipcRenderer.invoke('mcpgo:docs'),
 serviceRead:(service,route)=>ipcRenderer.invoke('mcpgo:service-read',service,route),
 serviceAction:(service,route,body)=>ipcRenderer.invoke('mcpgo:service-action',service,route,body),
 onboard:(action,payload)=>ipcRenderer.invoke('mcpgo:onboard',action,payload),
 onStatus:callback=>{
  if(typeof callback!=='function')return;
  const listener=(_event,data)=>callback(data);
  ipcRenderer.on('mcpgo:status',listener);
  return ()=>ipcRenderer.removeListener('mcpgo:status',listener);
 }
}));

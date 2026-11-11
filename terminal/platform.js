'use strict';
// Platform boundary for persistent, recoverable terminal operations.
// macOS paths and zsh behavior intentionally remain byte-for-byte compatible.
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
function isWindows(platform=process.platform) { return platform === 'win32'; }
function dataRoot(platform=process.platform, env=process.env, home=os.homedir()) {
  if(isWindows(platform)) return path.win32.join(env.LOCALAPPDATA || path.win32.join(home,'AppData','Local'),'McpGo');
  return path.join(home,'Library','Application Support','McpGo');
}
function jobRoot(platform=process.platform, env=process.env, home=os.homedir()) {
  if(env.MCPGO_JOB_ROOT) return env.MCPGO_JOB_ROOT;
  if(isWindows(platform)) return path.win32.join(dataRoot(platform,env,home),'OneShotJobs');
  return path.join(home,'Library','Application Support','ChatTerminalHub','OneShotJobs');
}
function commandSpec(command, platform=process.platform) {
  if(!isWindows(platform)) return {file:'/bin/zsh',args:['-lc',command]};
  // -EncodedCommand prevents the Windows argv quoting rules from modifying
  // PowerShell syntax. The command is UTF-16LE as specified by PowerShell.
  // PowerShell 5.1 otherwise writes redirected Unicode output using a legacy code page.
  const utf8='[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n';
  const encoded=Buffer.from(utf8+command,'utf16le').toString('base64');
  if(encoded.length>24576) throw Error('WINDOWS_COMMAND_TOO_LONG');
  return {file:'powershell.exe',args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded]};
}
function childEnv(platform=process.platform, env=process.env, home=os.homedir()) {
  const username=os.userInfo().username;
  if(isWindows(platform)) return {...env,HOME:home,USER:username,LOGNAME:username,
    ELECTRON_RUN_AS_NODE:env.ELECTRON_RUN_AS_NODE || undefined};
  return {HOME:home,USER:username,LOGNAME:username,
    PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    LANG:'en_US.UTF-8',TMPDIR:os.tmpdir()};
}
function killTree(pid, signal='SIGTERM', platform=process.platform) {
  if(!Number.isInteger(pid) || pid<=0) return false;
  if(isWindows(platform)) {
    const result=spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{
      windowsHide:true,timeout:5000,stdio:'ignore'});
    return !result.error && result.status===0;
  }
  try { process.kill(-pid,signal);return true; } catch { return false; }
}
module.exports={isWindows,dataRoot,jobRoot,commandSpec,childEnv,killTree};

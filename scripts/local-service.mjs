import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=fileURLToPath(new URL('../',import.meta.url));
const label='com.liuyubo.shangtu-ai';
const domain=`gui/${process.getuid?.()}`;
const target=`${domain}/${label}`;
const stateDir=path.join(root,'.private','local-service');
const plist=path.join(os.homedir(),'Library','LaunchAgents',`${label}.plist`);
const base='http://127.0.0.1:5178';
const instanceId=createHash('sha256').update(root).digest('hex').slice(0,16);
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

export function agentPlist(project,node,logs){
 return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(project,'scripts/start-configured.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string><key>PORT</key><string>5178</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>330</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs,'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs,'stderr.log'))}</string>
</dict></plist>\n`;
}
function launch(args,required=true){
 const result=spawnSync('/bin/launchctl',args,{encoding:'utf8',timeout:15000});
 if(required&&result.status!==0)throw Error(`launchctl ${args[0]} 失败，请查看系统后台项目设置或运行 service:status。`);
 return result;
}
function loaded(){return launch(['print',target],false).status===0;}
async function get(url){
 const res=await fetch(base+url,{signal:AbortSignal.timeout(2500)});
 if(!res.ok)throw Error(`HTTP ${res.status}`);
 return res.json();
}
async function health(){
 try{
  const h=await get('/healthz');
  return h.service==='shangtu-ai'&&h.instanceId===instanceId&&h.status==='ok'?h:null;
 }catch{return null;}
}
async function portInUse(){
 const net=await import('node:net');
 return new Promise(resolve=>{
  const socket=net.connect({host:'127.0.0.1',port:5178});
  const done=value=>{socket.destroy();resolve(value);};
  socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(1500,()=>done(true));
 });
}
async function assertIdle(){
 if(!await health())return;
 const payloads=await Promise.all(['/tasks','/text-runs','/kit-runs','/health'].map(p=>get('/api/backend-v1'+p)));
 const records=payloads.slice(0,3).flatMap(p=>p.tasks??p.runs??[]);
 if(records.some(r=>['queued','running'].includes(r.state))||payloads[3].text?.busy)
  throw Error('有任务正在执行或排队，暂不停止服务。请等任务结束后再操作。');
}
function verifyInstalled(){
 if(!fs.existsSync(plist))return false;
 const existing=fs.readFileSync(plist,'utf8');
 if(!existing.includes(xml(path.join(root,'scripts/start-configured.mjs'))))throw Error('同名后台服务属于另一个目录，未覆盖。');
 return true;
}
function rotateLogs(){
 for(const name of ['stdout.log','stderr.log']){
  const p=path.join(stateDir,name);
  if(fs.existsSync(p)&&fs.statSync(p).size>5*1024*1024)fs.renameSync(p,`${p}.${Date.now()}`);
 }
}
async function install(){
 verifyInstalled();
 if(loaded()){await waitReady();await status();return;}
 if(await portInUse())throw Error('5178已有服务监听。请先确认并正常停止手动服务，避免重复启动。');
 fs.mkdirSync(stateDir,{recursive:true,mode:0o700});rotateLogs();
 fs.mkdirSync(path.dirname(plist),{recursive:true});
 if(fs.existsSync(plist))fs.copyFileSync(plist,path.join(stateDir,`agent-before-${Date.now()}.plist`));
 const content=agentPlist(root,process.execPath,stateDir);
 fs.writeFileSync(path.join(stateDir,'agent.plist'),content,{mode:0o600});
 fs.writeFileSync(plist,content,{mode:0o600});
 const valid=spawnSync('/usr/bin/plutil',['-lint',plist],{encoding:'utf8'});
 if(valid.status!==0)throw Error('后台配置格式校验失败，未加载。');
 launch(['enable',target]);launch(['bootstrap',domain,plist]);
 await waitReady();await status();
}
async function waitReady(previousPid){
 for(let i=0;i<40;i++){
  const h=await health();
  if(h&&h.pid!==previousPid)return;
  await delay(250);
 }
 throw Error('服务尚未就绪。请查看 .private/local-service/stderr.log；未清除数据或自动重试模型。');
}
async function status(){
 const running=loaded(),h=await health();
 let model=null;
 if(h){try{const m=await get('/api/backend-v1/health');model={ready:m.ready,paused:m.modelCallsPaused,billingUnknown:m.billingUnknown};}catch{}}
 console.log(JSON.stringify({url:base,installed:fs.existsSync(plist),managed:running,available:!!h,pid:h?.pid,startedAt:h?.startedAt,model,logs:stateDir},null,2));
 return !!h;
}
async function stop(disable=true){
 if(!verifyInstalled())return;
 await assertIdle();
 if(disable)launch(['disable',target]);
 if(loaded())launch(['bootout',target]);
}
async function main(){
 if(process.platform!=='darwin')throw Error('此后台管理脚本适用于 macOS；其他系统使用 npm start。');
 switch(process.argv[2]??'status'){
  case 'install':await install();break;
  case 'start':
   if(!verifyInstalled()){await install();break;}
   if(!loaded()){
    if(await portInUse())throw Error('5178已有手动服务，未重复启动。');
    launch(['enable',target]);launch(['bootstrap',domain,plist]);
   }
   await waitReady();await status();break;
  case 'status':if(!await status())process.exitCode=1;break;
  case 'stop':await stop();console.log('后台服务已停止并关闭自动启动；service:start 可恢复。');break;
  case 'restart':
   if(!verifyInstalled()){await install();break;}
   if(loaded()){
    await assertIdle();
    const previous=await health();
    if(previous){
     // Keep the registration: bootout returns before launchd finishes removing
     // the job, so immediately bootstrapping it can fail and leave the site off.
     launch(['kill','SIGTERM',target]);
     await waitReady(previous.pid);
    }else await waitReady();
   }else{
    if(await portInUse())throw Error('5178已有手动服务，未重复启动。');
    launch(['enable',target]);launch(['bootstrap',domain,plist]);await waitReady();
   }
   await status();break;
  case 'uninstall':
   await stop();if(fs.existsSync(plist))fs.unlinkSync(plist);console.log('已移除后台注册，项目、日志和资料均保留。');break;
  default:throw Error('用法：node scripts/local-service.mjs install|start|status|stop|restart|uninstall');
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
}

import fs from 'node:fs';
import path from 'node:path';
import {Fault} from '../core.mjs';

export const currentKey=value=>typeof value==='function'?value():value;

const unavailable=()=>new Fault('UNSAFE_CREDENTIAL','服务端凭证未配置或私有文件不安全',500);
function validate(value){
 const key=value.trim();
 if(key.length<16||key.length>4096||!(/^[\x21-\x7e]+$/).test(key))throw unavailable();
 return key;
}

// Only the server imports this module. Credentials never enter the API response.
export function loadApiKey(root,env=process.env){
 if(env.ARK_API_KEY)return validate(env.ARK_API_KEY);
 if(!env.ARK_API_KEY_FILE)return '';
 let fd;
 try{
  const privateRoot=path.join(fs.realpathSync(root),'.private');
  const requested=path.resolve(env.ARK_API_KEY_FILE),real=fs.realpathSync(requested);
  const relative=path.relative(privateRoot,real);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||fs.lstatSync(requested).isSymbolicLink())throw unavailable();
  fd=fs.openSync(real,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.nlink!==1||stat.size>4097||stat.uid!==process.getuid())throw unavailable();
  return validate(fs.readFileSync(fd,'utf8'));
 }catch{
  // Never interpolate credential contents or the original exception.
  throw unavailable();
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function loadMimoKey(root,env=process.env){
 const defaultFile=path.join(root,'.private','mimo-api-key');
 const file=env.MIMO_API_KEY_FILE||(fs.existsSync(defaultFile)?defaultFile:'');
 const key=loadApiKey(root,{ARK_API_KEY:env.MIMO_API_KEY,ARK_API_KEY_FILE:file});
 if(key&&!/^sk-[\x21-\x7e]{13,4093}$/.test(key))throw unavailable();
 return key;
}

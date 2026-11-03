import {fileURLToPath} from 'node:url';

// Paths only: the secret is read inside the server, never passed on the command line.
process.env.AIGC_CONFIG_FILE??=fileURLToPath(new URL('../.private/integration-round1.json',import.meta.url));
process.env.ARK_API_KEY_FILE??=fileURLToPath(new URL('../.private/ark-api-key',import.meta.url));
try{await import('../server.mjs');}
catch{console.error('服务启动失败，请检查私有配置、凭证文件权限及数据目录。');process.exitCode=1;}

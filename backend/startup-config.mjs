import fs from 'node:fs';
import path from 'node:path';

// All local entry points use the same saved settings. An isolated data directory
// must explicitly opt into a config, rather than inherit the production budget.
export function configureStartup(root,env=process.env){
 if(env.AIGC_DATA_DIR)return;
 const defaults={AIGC_CONFIG_FILE:'integration-round1.json',ARK_API_KEY_FILE:'ark-api-key'};
 for(const [name,file] of Object.entries(defaults)){
  const target=path.join(root,'.private',file);
  if(env[name]===undefined&&fs.existsSync(target))env[name]=target;
 }
}

import { Store } from '../../backend/store.mjs';
import { TEST_CONTRACT } from './test-processor.mjs';
const store=new Store({dataDir:process.argv[2],processor:TEST_CONTRACT});
const claim=store.claim(TEST_CONTRACT);
process.stdout.write(JSON.stringify({attemptId:claim.attemptId,childId:claim.childId})+'\n');
// Parent sends SIGKILL after a durable claim; intentionally no close/finally handler.
setInterval(()=>{},1000);

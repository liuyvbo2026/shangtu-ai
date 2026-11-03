import {fail,hash,canonical} from '../core.mjs';

// Generated text stays in its immutable text run. Edits are append-only, so a
// second browser or a restart can recover every saved revision without a model call.
export function listingEdits(store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS listing_edits(task_id TEXT NOT NULL REFERENCES tasks(id),revision INTEGER NOT NULL,request_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,revision))`);
 const view=r=>({taskId:r.task_id,revision:r.revision,text:r.text,createdAt:r.created_at});
 const history=id=>{store.task(id);return store.all('SELECT * FROM listing_edits WHERE task_id=? ORDER BY revision DESC',id).map(view);};
 return {
  history,
  list:()=>store.all('SELECT e.* FROM listing_edits e WHERE revision=(SELECT MAX(revision) FROM listing_edits WHERE task_id=e.task_id)').map(view),
  save(id,input,key){
   fail(typeof key==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(key),'INVALID_INPUT','需要有效保存编号');
   fail(input&&Object.keys(input).every(k=>['text','expectedRevision'].includes(k))&&typeof input.text==='string'&&input.text.length<=20000&&Number.isInteger(input.expectedRevision),'INVALID_INPUT','文案最多20000字，需要当前版本');
   const digest=hash(canonical({taskId:id,...input})),old=store.get('SELECT * FROM listing_edits WHERE request_key=?',key);
   if(old){fail(old.request_hash===digest,'IDEMPOTENCY_CONFLICT','保存内容已改变',409);return view(old);}
   const task=store.task(id);fail(!task.input.settings.correction,'INVALID_INPUT','请保存到原套图任务');
   return store.transaction(()=>{
    const current=store.get('SELECT MAX(revision) AS n FROM listing_edits WHERE task_id=?',id).n??0;
    fail(current===input.expectedRevision,'REVISION_CONFLICT','其他窗口已保存新文案。你的草稿已保留，请查看最新版本后再保存',409);
    store.run('INSERT INTO listing_edits VALUES(?,?,?,?,?,?)',id,current+1,key,digest,input.text,Date.now());
    return view(store.get('SELECT * FROM listing_edits WHERE request_key=?',key));
   });
  }
 };
}

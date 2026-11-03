import {fail} from '../core.mjs';

// Local product submissions are intentional uploads to the selected models.
// Keep the consent separate from credentials and from asset storage alone.
export function referenceConsent(store,config){
 store.db.exec(`CREATE TABLE IF NOT EXISTS reference_consents(sha256 TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES assets(id),action TEXT NOT NULL,approved_at INTEGER NOT NULL)`);
 const approve=(assetIds,action)=>{
  if(config.allowUserSubmittedReferences!==true)return;
  store.transaction(()=>{for(const id of assetIds){const a=store.asset(id);fail(a.kind==='original','INVALID_INPUT','只能使用已上传的商品原图');store.run('INSERT OR IGNORE INTO reference_consents VALUES(?,?,?,?)',a.sha256,a.id,action,Date.now());}});
 };
 return {
  hashes:()=>store.all('SELECT sha256 FROM reference_consents').map(r=>r.sha256),
  restore:assetId=>approve([assetId],'submit-product-restore'),
  submit(items,action){
   if(config.allowUserSubmittedReferences!==true)return;
   const references=items.flatMap(item=>{
    const p=store.product(item.productId);
    fail(p.revision===item.productRevision,'REVISION_CONFLICT','商品资料已改变，请重新保存',409);
    return p.references;
   });
   approve(references.map(r=>r.assetId),action);
  }
 };
}

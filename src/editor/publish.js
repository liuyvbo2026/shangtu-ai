// An explicit save creates a result version; independent drafts remain intact.
// Read durable receipts before rendering/uploading so a lost response is safe.
export async function publishToKit(session,render,api){
 const source=session.source;
 if(source.kind!=='kit-result')throw Error('此文档没有关联套图结果');
 const route='/results/'+encodeURIComponent(source.resultId),result=await api(route);
 const prefix=session.documentId+':',key=prefix+session.currentVersionId;
 const existing=result.versions.find(v=>v.editKey===key);
 if(existing)return {version:existing.version,duplicate:true};
 const published=result.versions.filter(v=>v.editKey?.startsWith(prefix)).at(-1);
 const base=published??result.versions.find(v=>v.version===source.resultVersion);
 if(!base||!published&&base.assetId!==source.serverAssetId)throw Error('原始结果版本不匹配，编辑稿已保留');
 if(result.versions.at(-1).version!==base.version)throw Error('套图已有更新版本。当前编辑稿已保留，请从最新图片打开编辑后合并修改。');
 const blob=await render();
 const asset=await api('/assets?kind=derived&parentId='+encodeURIComponent(base.assetId),{method:'POST',body:blob,headers:{'Content-Type':'image/png','X-Asset-Name':encodeURIComponent(session.name+'.png')}});
 const saved=await api(route+'/versions',{method:'POST',headers:{'Idempotency-Key':key},body:{assetId:asset.id,expectedVersion:base.version}});
 const receipt=saved.versions.find(v=>v.editKey===key);
 if(!receipt)throw Error('保存回执待核对，请重新点击保存；编辑稿已保留');
 return {version:receipt.version,duplicate:false};
}

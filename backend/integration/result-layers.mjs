import {fail} from '../core.mjs';

// Only expose layers bound to this immutable result version and its actual
// provider receipt. A later AI edit or manual upload is a new flattened image.
export function resultLayers(store,resultId,version){
 const result=store.result(resultId),v=result.versions.find(v=>v.version===version);
 fail(v,'NOT_FOUND','找不到此图片版本',404);
 const fallback={version,available:false};
 if(!v.attemptId)return fallback;
 const attempt=store.get('SELECT receipt_json FROM attempts WHERE id=?',v.attemptId);
 const layers=attempt?.receipt_json?JSON.parse(attempt.receipt_json).workflow?.layers:null;
 if(!layers?.length||!layers.every(l=>l.kind==='text'&&l.fontFamily==='PingFang SC'&&Array.isArray(l.sourceIds)))return fallback;
 const call=store.get("SELECT asset_id FROM provider_calls WHERE attempt_id=? AND state='received'",v.attemptId)??store.get("SELECT p.asset_id FROM compose_recoveries r JOIN provider_calls p ON p.id=r.source_call_id WHERE r.attempt_id=? AND p.state='received'",v.attemptId);
 if(!call?.asset_id)return fallback;
 const adaptive=store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='adaptive_compositions'")?store.get('SELECT * FROM adaptive_compositions WHERE attempt_id=?',v.attemptId):null;
 if(adaptive)fail(adaptive.base_asset_id===call.asset_id,'LAYER_SOURCE_CHANGED','排版底图与原始模型回执不匹配',409);
 const base=store.asset(adaptive?.underlay_asset_id??call.asset_id),output=store.asset(v.assetId);
 fail(base.width===output.width&&base.height===output.height,'LAYER_SOURCE_CHANGED','文字底图尺寸与结果不一致',409);
 return {version,available:true,baseAssetId:base.id,compositeAssetId:v.assetId,width:base.width,height:base.height,layers,...(adaptive?{originalBaseAssetId:call.asset_id,layoutAudit:JSON.parse(adaptive.layout_json).audit}:{})};
}

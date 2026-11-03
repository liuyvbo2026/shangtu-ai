/** 05A.1 — interchange types; no server/network integration is installed. */
export type Rect = {x:number; y:number; width:number; height:number};
export interface EditorAsset {
  id: `sha256:${string}`;
  sha256: string;
  name: string;
  width: number;
  height: number;
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  blob: Blob;
}
export interface BaseLayer extends Rect {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
}
export interface ImageLayer extends BaseLayer {type:'image'; assetId:string; sourceRect:Rect}
export interface TextLayer extends BaseLayer {
  type:'text'; text:string;
  style:{fontFamily:'system'|'serif'|'mono'; fontSize:number; fontWeight:400|500|600|700;
    italic:boolean; color:string; align:'left'|'center'|'right'; lineHeight:number};
}
export interface Scene {width:number; height:number; background:string; layers:(ImageLayer|TextLayer)[]}
export interface EditVersion {
  id:string; parentId:string|null; restoredFrom:string|null;
  createdAt:number; label:string; scene:Scene;
}
export interface EditSession {
  schemaVersion:1; documentId:string; name:string;
  source:{assetId:string; width:number; height:number; [key:string]:unknown};
  originalVersionId:string; savedVersionId:string; currentVersionId:string;
  versions:EditVersion[]; undo:string[]; redo:string[];
}
export interface DocumentRecord {id:string; etag:number; session:EditSession; updatedAt:number}
export interface EditorRepository {
  getAsset(id:string):Promise<EditorAsset|undefined>;
  loadDocument(id:string):Promise<DocumentRecord|undefined>;
  persistDocument(session:EditSession, options?:{expectedEtag?:number|null; assets?:EditorAsset[]}):Promise<DocumentRecord>;
}

/** Requested integration DTO, pending agreement with stages 2/3. Stable IDs only. */
export interface ResultForEditing {
  contract:'05A.1';
  workspaceId:string; productSnapshotId:string; taskId:string; childId:string;
  resultId:string; expectedResultVersion:number;
  originalResultAssetId:string; currentResultAssetId:string;
  referenceAssetIds:string[];
  assetManifest:{serverId:string; localId:EditorAsset['id']; sha256:string; mediaType:EditorAsset['type']; width:number; height:number}[];
  /** Empty when the only source is a flattened image. Never label OCR pixels editable text. */
  composition?:{background:string; layers:(ImageLayer|TextLayer)[]; cleanBackgroundAssetId:string};
}
export interface SelectionForModel {
  contract:'05A.1'; documentId:string; baseEditVersionId:string;
  resultId:string; expectedResultVersion:number; targetLayerId:string;
  documentRect:Rect;
  source:{assetId:string; rect:Rect; normalized:Rect};
  coordinateSpace:'decoded-source-pixels';
}
/** Save only to a new derived asset; backend result pointer must advance atomically. */
export interface EditPublication {
  contract:'05A.1'; resultId:string; expectedResultVersion:number;
  documentId:string; editVersionId:string; parentAssetId:string;
  composition:EditSession;
  export:{blob:Blob; mediaType:'image/png'; width:number; height:number; sha256:string};
}

// Server-side, dependency-free JSON Schema subset. No queue or provider is installed here.
export const VERSIONS = Object.freeze({schema:'03A.1', workflow:'03A.1.0', prompt:'03A.prompt.1-draft', nodes:'03A.nodes.1'});
export const TYPES = Object.freeze(['white','selling','scene','other']);
export const ROLES = Object.freeze(['product','detail','packaging','style','layout','current','baseline']);
const str = {type:'string', minLength:1, maxLength:12000};
const id = {type:'string', minLength:1, maxLength:100, pattern:'^[a-zA-Z0-9_.:-]+$'};
const integer = {type:'integer', minimum:1};
const array = (items, minItems = 0) => ({type:'array', items, minItems});
const object = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const enumeration = values => ({type:'string', enum:values});
const nullableId = {anyOf:[id,{type:'null'}]};
const version = {const:VERSIONS.schema};
const size = object({width:integer, height:integer});
const box = {type:'array', items:{type:'number', minimum:0, maximum:1}, minItems:4, maxItems:4};
const fact = object({id, key:str, value:str, source:object({kind:{const:'user-confirmed'}, locator:str})});
const reference = object({id, assetId:id, role:enumeration(ROLES), purpose:str});
const unknown = object({key:str, reason:str});
const layout = object({id, version:str, allowedTypes:array(enumeration(TYPES),1), ratios:array(str,1), referenceId:nullableId,
  subjectBox:box, textSlots:array(object({id, box, maxChars:integer, maxLines:integer}))});

export const schemas = {
  input:object({schemaVersion:version, product:object({id, revision:integer, name:str, facts:array(fact), unknowns:array(unknown), references:array(reference,1)}),
    requirements:object({description:str, platform:str, language:str, counts:object(Object.fromEntries(TYPES.map(t=>[t,{type:'integer',minimum:0}]))),
      ratio:str, size, layoutIds:array(id)}), layouts:array(layout)}),
  understanding:object({schemaVersion:version, productId:id, productRevision:integer, facts:array(fact),
    inferred:array(object({id, key:str, value:str, confidence:{type:'number',minimum:0,maximum:1}, evidenceReferenceIds:array(id,1)})),
    unknowns:array(unknown), conflicts:array(object({key:str, factIds:array(id), referenceIds:array(id), reason:str})), references:array(reference,1)}),
  plan:object({schemaVersion:version, productId:id, productRevision:integer, understandingDigest:str,
    visual:object({palette:array(str,1), font:str, lighting:str, background:str}),
    images:array(object({id, type:enumeration(TYPES), purpose:str, content:str, factIds:array(id),
      copy:array(object({text:str, factIds:array(id,1), slotId:id})), layoutId:nullableId,
      composition:object({subjectBox:box}), references:array(object({referenceId:id, role:enumeration(ROLES)}),1),
      dependencies:array(object({imageId:id, use:{const:'baseline'}})), ratio:str, size,
      method:{const:'generate'}, textMode:enumeration(['editable-overlay','provider-rendered','source-aware-overlay'])}),1)}),
  raster:object({base64:{type:'string',minLength:1,maxLength:60000000},mediaType:{const:'image/png'},width:integer,height:integer,
    provenance:enumeration(['test-only','provider','compositor']),requestId:{anyOf:[id,{type:'null'}]}}),
  quality:object({passed:{type:'boolean'}, evidence:enumeration(['test-only','model-review','human-review','structural-check']),
    issues:array(object({code:id, severity:enumeration(['warning','error']), message:str}))})
};

/** Only the keywords used by the exported schemas are implemented; not a general JSON Schema engine. */
export function schemaIssues(schema, value, path = '$') {
  const errors = [], add = message => errors.push({code:'SCHEMA', path, message});
  if (schema.anyOf) return schema.anyOf.some(s=>schemaIssues(s,value,path).length===0) ? [] : [{code:'SCHEMA',path,message:'No matching shape'}];
  if ('const' in schema && value !== schema.const) add('Unsupported constant/version');
  if (schema.enum && !schema.enum.includes(value)) add('Unsupported enum value');
  const type = schema.type;
  const valid = !type || (type==='null' ? value===null : type==='array' ? Array.isArray(value) :
    type==='object' ? !!value && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype :
    type==='integer' ? Number.isSafeInteger(value) : type==='number' ? typeof value==='number' && Number.isFinite(value) : typeof value===type);
  if (!valid) { add(`Expected ${type}`); return errors; }
  if (type==='string') {
    if (!value.trim() || value.length < (schema.minLength??0) || value.length > (schema.maxLength??Infinity)) add('Invalid string length');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add('Invalid identifier');
  }
  if (type==='number' || type==='integer') if (value < (schema.minimum??-Infinity) || value > (schema.maximum??Infinity)) add('Number outside range');
  if (type==='array') {
    if (value.length < (schema.minItems??0) || value.length > (schema.maxItems??Infinity)) add(`Invalid array length: received ${value.length}; minimum ${schema.minItems??0}; maximum ${schema.maxItems??'unbounded'}`);
    for(let i=0;i<value.length;i++) errors.push(...schemaIssues(schema.items,value[i],`${path}[${i}]`));
  }
  if (type==='object') {
    for (const key of schema.required??[]) if (!Object.hasOwn(value,key)) errors.push({code:'SCHEMA',path:`${path}.${key}`,message:'Required field missing'});
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties,key)) errors.push({code:'SCHEMA',path:`${path}.${key}`,message:'Unknown field'});
      else errors.push(...schemaIssues(schema.properties[key],value[key],`${path}.${key}`));
    }
  }
  return errors;
}

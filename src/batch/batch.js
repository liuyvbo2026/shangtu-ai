import {snapshot, identifier, integer, requireValue, unique, record} from './value.js';
import {DEFAULT_RULES, createRules, effectiveSettings, IMAGE_TYPES} from './settings.js';

export function createBatchSnapshot(draft, products, policy = DEFAULT_RULES) {
  const rules = createRules(policy);
  identifier(draft.id, 'batch ID'); integer(draft.createdAt, 'createdAt');
  requireValue(Array.isArray(draft.items) && draft.items.length > 0, 'EMPTY_BATCH', 'Select at least one product');
  requireValue(rules.maxItems === null || draft.items.length <= rules.maxItems, 'BATCH_LIMIT', 'Batch exceeds configured capacity');
  requireValue(['immediate', 'queue'].includes(draft.mode), 'INVALID_MODE', 'Invalid execution preference');
  unique(products.map(p => p.id), 'product ID'); unique(draft.items.map(i => i.id), 'batch item ID');
  const items = draft.items.map((item, position) => {
    identifier(item.id, 'item ID');
    const product = products.find(p => p.id === item.productId);
    requireValue(!!product, 'PRODUCT_MISSING', 'Batch product is missing');
    identifier(product.id, 'product ID'); integer(product.revision, 'product revision', 1);
    requireValue(typeof product.name === 'string' && product.name.trim() && record(product.facts), 'INVALID_PRODUCT', 'Product requires name and facts');
    const refs = product.references;
    requireValue(Array.isArray(refs) && refs.length >= rules.minReferences && refs.length <= rules.maxReferences, 'REFERENCE_LIMIT', 'Invalid product reference count');
    unique(refs.map(r => r.id), 'reference ID'); unique(refs.map(r => r.assetId), 'reference asset');
    refs.forEach((r, index) => {
      identifier(r.id, 'reference ID'); identifier(r.assetId, 'reference asset ID');
      requireValue(r.position === index && typeof r.role === 'string' && r.role.length > 0, 'INVALID_REFERENCE', 'References must have ordered positions and roles');
    });
    requireValue(!rules.requireConfirmation || item.confirmed === true, 'CONFIRMATION_REQUIRED', 'Confirm each product before submission');
    requireValue(typeof item.description === 'string' && (!rules.requireDescription || item.description.trim().length > 0), 'DESCRIPTION_REQUIRED', 'Product description is required');
    const {settings, notices} = effectiveSettings(draft.global, item.override ?? {}, rules);
    const total = IMAGE_TYPES.reduce((n, type) => n + settings.counts[type], 0);
    requireValue(total >= rules.minImages, 'IMAGE_MINIMUM', 'Image count is below configured minimum');
    const size = rules.sizeMap[`${settings.resolution}/${settings.ratio}`];
    if (size) { integer(size.width, 'width', 1); integer(size.height, 'height', 1); }
    const slots = IMAGE_TYPES.flatMap(type => Array.from({length: settings.counts[type]}, (_, index) => ({
      key: `${type}-${String(index + 1).padStart(3, '0')}`, type, index: index + 1,
      layoutId: type === 'selling' ? settings.layouts[index] ?? null : null,
      ...(size ? {size} : {})
    })));
    return {
      id: item.id, position, productId: product.id,
      product: {id: product.id, revision: product.revision, name: product.name, facts: product.facts, references: refs},
      description: item.description, override: item.override ?? {}, settings, slots,
      notices: [...notices, ...(!size ? [{code: 'OUTPUT_SIZE_UNVERIFIED'}] : [])]
    };
  });
  return snapshot({schemaVersion: 1, id: draft.id, createdAt: draft.createdAt, mode: draft.mode, global: draft.global, rules, items});
}

export function batchItem(batch, itemId) {
  const item = batch.items.find(i => i.id === itemId);
  requireValue(!!item, 'ITEM_MISSING', 'Batch item does not exist');
  return item;
}

import {cloneJSON, snapshot, record, requireValue, pathParts, integer} from './value.js';

export const IMAGE_TYPES = Object.freeze(['white', 'selling', 'scene', 'other']);
const observedPlatforms = ['亚马逊', '淘宝天猫1688', 'Temu', 'TikTok Shop', '拼多多', '抖音电商', 'OZON', '独立站', 'Shopee', '阿里国际站', '速卖通', 'SHEIN', '京东', '美客多', 'Coupang', 'Wayfair'];
const domesticPlatforms = new Set(['淘宝天猫1688', '拼多多', '抖音电商', '京东']);

// Latest recorded form observations, not generated-result/model acceptance.
export const DEFAULT_RULES = snapshot({
  version: '06A-v2-flexible-counts',
  minReferences: 1, maxReferences: 6, minImages: 1, maxImages: 20,
  maxItems: null, requireConfirmation: true, requireDescription: true,
  layoutOverflow: 'trim',
  platformLinks: Object.fromEntries(observedPlatforms.map(platform => [platform, {counts:
    domesticPlatforms.has(platform) ? {white: 0, selling: 3, scene: 2, other: 2} : {white: 1, selling: 3, scene: 2, other: 1}
  }])),
  countryTransitions: [{from: '中国', to: '德国', whenLanguage: '中文', language: '德语'}],
  preserveLanguagesOnCountryChange: ['无文字'],
  sizeMap: {},
  evidence: {
    references: 'REFERENCE-RESEARCH.md 商品套图：历史实测1–6张',
    maxImages: 'REFERENCE-RESEARCH.md：历史实测总数20',
    platformLinks: 'reference-2026-10-28/05-platform-transitions.json：16平台结构；本次会话保留地区/语言/比例/分辨率，取代10月26日联动推定',
    countryTransitions: 'reference-2026-10-28/06-country-change.json：中国/中文→德国/德语；其他非无文字语言转换待核实',
    preserveLanguagesOnCountryChange: 'reference-2026-10-28/08-country-language-transitions.json：无文字切换11地区仍保留',
    minImages: '2026-11-02用户明确要求四图；允许1–20，不作为原站最小数量的实测证据',
    confirmation: '本模块提交保护约定，原站确认失效条件待核实',
    layoutOverflow: '容量随卖点数变化已观察；自动裁剪方式为本地约定',
    sizeMap: '空表；禁止沿用演示outputSize推定模型尺寸',
    maxItems: '未知，不沿用演示50卡上限；服务端容量另验'
  }
});

// Object fields merge recursively; arrays/null/empty strings replace atomically.
export function resolveSettings(global, override = {}) {
  requireValue(record(global) && record(override), 'INVALID_SETTINGS', 'Settings and overrides must be objects');
  const result = cloneJSON(global), patch = cloneJSON(override);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = record(value) ? resolveSettings(record(result[key]) ? result[key] : {}, value) : value;
  }
  return result;
}

export function setOverride(override, path, value) {
  const out = cloneJSON(override), parts = pathParts(path);
  requireValue(record(out), 'INVALID_SETTINGS', 'Overrides must be an object');
  let target = out;
  for (const key of parts.slice(0, -1)) { if (!record(target[key])) target[key] = {}; target = target[key]; }
  target[parts.at(-1)] = cloneJSON(value);
  return out;
}

// Absence alone means follow global. Deleting a nested leaf preserves siblings.
export function clearOverride(override, path) {
  const out = cloneJSON(override);
  requireValue(record(out), 'INVALID_SETTINGS', 'Overrides must be an object');
  if (path === undefined) return {};
  function remove(target, parts) {
    const [key, ...rest] = parts;
    if (!rest.length) delete target[key];
    else if (record(target[key])) { remove(target[key], rest); if (!Object.keys(target[key]).length) delete target[key]; }
  }
  remove(out, pathParts(path));
  return out;
}

export function createRules(patch = {}) {
  const rules = resolveSettings(DEFAULT_RULES, patch);
  // Maps are replacements, so a caller can explicitly disable historical links.
  for (const key of ['platformLinks', 'sizeMap']) if (Object.hasOwn(patch, key)) rules[key] = cloneJSON(patch[key]);
  for (const key of ['minReferences', 'maxReferences', 'minImages', 'maxImages']) integer(rules[key], key, 1);
  if (rules.maxItems !== null) integer(rules.maxItems, 'maxItems', 1);
  requireValue(rules.minReferences <= rules.maxReferences && rules.minImages <= rules.maxImages &&
    ['trim', 'reject'].includes(rules.layoutOverflow) && record(rules.platformLinks) && record(rules.sizeMap) &&
    typeof rules.requireConfirmation === 'boolean' && typeof rules.requireDescription === 'boolean' &&
    Array.isArray(rules.countryTransitions) && rules.countryTransitions.every(r => record(r) &&
      ['from', 'to', 'whenLanguage', 'language'].every(k => typeof r[k] === 'string')) &&
    Array.isArray(rules.preserveLanguagesOnCountryChange) && rules.preserveLanguagesOnCountryChange.every(v => typeof v === 'string'), 'INVALID_RULES', 'Invalid batch policy');
  return snapshot(rules);
}

function linked(settings, platform, rules) {
  const known = Object.hasOwn(rules.platformLinks, platform);
  return {
    settings: resolveSettings({...settings, platform}, known ? rules.platformLinks[platform] : {}),
    notices: known ? [] : [{code: 'PLATFORM_LINK_UNKNOWN', platform}]
  };
}

export function changeGlobalPlatform(global, platform, rules = DEFAULT_RULES) {
  requireValue(typeof platform === 'string' && platform.length > 0, 'INVALID_PLATFORM', 'Choose a platform');
  const result = linked(global, platform, rules);
  return normalize(result.settings, rules, result.notices);
}

function countryLinked(settings, country, rules) {
  const transition = rules.countryTransitions.find(r => r.from === settings.country && r.to === country && r.whenLanguage === settings.language);
  const preserved = country === settings.country || rules.preserveLanguagesOnCountryChange.includes(settings.language);
  return {settings: {...settings, country, ...(transition ? {language: transition.language} : {})},
    notices: transition || preserved ? [] : [{code: 'COUNTRY_LINK_UNKNOWN', from: settings.country, country, language: settings.language}]};
}

export function changeGlobalCountry(global, country, rules = DEFAULT_RULES) {
  requireValue(typeof country === 'string' && country.length > 0, 'INVALID_COUNTRY', 'Choose a country');
  const result = countryLinked(global, country, rules);
  return normalize(result.settings, rules, result.notices);
}

function normalize(settings, rules, notices = []) {
  const result = cloneJSON(settings);
  requireValue(record(result.counts) && Object.keys(result.counts).length === IMAGE_TYPES.length &&
    IMAGE_TYPES.every(type => Object.hasOwn(result.counts, type)), 'INVALID_COUNTS', 'Expected the four image counts');
  IMAGE_TYPES.forEach(type => integer(result.counts[type], `counts.${type}`));
  const total = IMAGE_TYPES.reduce((n, type) => n + result.counts[type], 0);
  requireValue(total <= rules.maxImages, 'IMAGE_LIMIT', 'Image count exceeds configured maximum');
  requireValue(Array.isArray(result.layouts) && result.layouts.every(id => typeof id === 'string' && id.length > 0) &&
    new Set(result.layouts).size === result.layouts.length, 'INVALID_LAYOUTS', 'Layouts must be unique IDs');
  if (result.layouts.length > result.counts.selling) {
    requireValue(rules.layoutOverflow === 'trim', 'LAYOUT_LIMIT', 'Too many layouts for selling images');
    notices = [...notices, {code: 'LAYOUTS_TRIMMED', removed: result.layouts.slice(result.counts.selling)}];
    result.layouts = result.layouts.slice(0, result.counts.selling);
  }
  return snapshot({settings: result, notices});
}

export function effectiveSettings(global, override = {}, rules = DEFAULT_RULES) {
  let base = {settings: cloneJSON(global), notices: []};
  if (Object.hasOwn(override, 'platform') && override.platform !== global.platform) {
    base = linked(base.settings, override.platform, rules);
  }
  if (Object.hasOwn(override, 'country') && override.country !== base.settings.country) {
    const country = countryLinked(base.settings, override.country, rules);
    base = {settings: country.settings, notices: [...base.notices, ...country.notices]};
  }
  // Explicit per-product fields win over linked defaults, including zero/false/null/empty.
  return normalize(resolveSettings(base.settings, override), rules, base.notices);
}

// Existing select controls used '' for follow-global. Opt in at the UI boundary only.
export function fromLegacyOverrides(override) {
  let result = cloneJSON(override);
  const removed = [];
  for (const key of ['platform', 'country', 'language', 'ratio', 'resolution']) {
    if (Object.hasOwn(result, key) && (result[key] === '' || result[key] === null)) {
      result = clearOverride(result, key); removed.push(key);
    }
  }
  return {override: result, removed};
}

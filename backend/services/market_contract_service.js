const crypto = require('node:crypto');
const { REFERENCE_MARKET_DEFINITION } = require('../config/market/reference_market_definition');

const SOURCE_MODES = new Set(['HISTORICAL_DATA', 'DEMO_SIMULATION', 'UNAVAILABLE']);
const MARKET_SOURCE_TYPES = new Set([
  'OBSERVED_MARKET_PRICE',
  'NUMERICAL_MODEL_FORECAST',
  'DETERMINISTIC_MARKET_SIMULATION',
  'LLM_SCENARIO_ESTIMATE_LEGACY',
  'UNAVAILABLE',
]);

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function marketDefinitionId(definition) {
  return `${definition.marketId}:v${definition.definitionVersion}`;
}

function validateMarketDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('marketDefinition is required');
  for (const field of ['marketId', 'displayName', 'marketType', 'referencePricingZone', 'currency', 'priceUnit', 'marketTimezone', 'congestionLimitations']) {
    requireText(definition[field], `marketDefinition.${field}`);
  }
  if (!Number.isInteger(definition.definitionVersion) || definition.definitionVersion < 1) throw new TypeError('marketDefinition.definitionVersion must be a positive integer');
  if (!Number.isInteger(definition.nativeIntervalMinutes) || definition.nativeIntervalMinutes !== 15) throw new TypeError('marketDefinition.nativeIntervalMinutes must be 15');
  if (!SOURCE_MODES.has(definition.sourceMode)) throw new TypeError(`marketDefinition.sourceMode must be one of ${[...SOURCE_MODES].join(', ')}`);
  if (definition.currency !== 'INR') throw new TypeError('Phase 2B.1 market currency must be INR');
  if (definition.priceUnit !== 'INR_PER_MWH') throw new TypeError('Canonical market price unit must be INR_PER_MWH');
  if (!definition.dataProvenance || typeof definition.dataProvenance !== 'object') throw new TypeError('marketDefinition.dataProvenance is required');
  if (definition.configurationVersion !== null && definition.configurationVersion !== undefined
      && (!Number.isInteger(definition.configurationVersion) || definition.configurationVersion < 1)) {
    throw new TypeError('marketDefinition.configurationVersion must be null or a positive integer');
  }
  return definition;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  REFERENCE_MARKET_DEFINITION,
  SOURCE_MODES,
  MARKET_SOURCE_TYPES,
  requireText,
  marketDefinitionId,
  validateMarketDefinition,
  stableJson,
  checksum,
};

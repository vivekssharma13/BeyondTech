const SOURCE_TYPES = new Set([
  'MODEL_PREDICTION',
  'OBSERVED',
  'HISTORICAL',
  'USER_CONFIGURED_SIMULATION',
  'LEGACY_CODE_ASSUMPTION',
  'ESTIMATED',
  'FALLBACK',
  'UNAVAILABLE',
  'WEATHER_DRIVEN_ENGINEERING_SIMULATION',
  'OBSERVED_MARKET_PRICE',
  'NUMERICAL_MODEL_FORECAST',
  'DETERMINISTIC_MARKET_SIMULATION',
  'LLM_SCENARIO_ESTIMATE_LEGACY',
  'AI_REASONING',
]);

const FORECAST_HORIZONS = new Set(['1h', '6h', '24h', '48h', '72h']);

function requireFinite(value, field, { min = -Infinity, max = Infinity, nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function requireTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  return value;
}

function validateFarmId(farmId, farms) {
  if (typeof farmId !== 'string' || !farms.some(farm => farm.farmId === farmId)) throw new TypeError(`Unknown farm identifier: ${farmId}`);
  return farmId;
}

function validateFarmState(farm) {
  requireFinite(farm.capacityMW, 'capacityMW', { min: 0.1 });
  requireFinite(farm.availabilityPct, 'availabilityPct', { min: 0, max: 100 });
  requireFinite(farm.batteryCapacityMWh, 'batteryCapacityMWh', { min: 0 });
  requireFinite(farm.batterySocPct, 'batterySocPct', { min: 0, max: 100 });
  requireFinite(farm.reservePct, 'reservePct', { min: 0, max: 100 });
  requireFinite(farm.gridExportLimitMW, 'gridExportLimitMW', { min: 0 });
  requireFinite(farm.gridImportLimitMW, 'gridImportLimitMW', { min: 0 });
  return farm;
}

function validateSourceType(value, field = 'sourceType') {
  if (!SOURCE_TYPES.has(value)) throw new TypeError(`${field} must be one of ${[...SOURCE_TYPES].join(', ')}`);
  return value;
}

function validateGenerationForecast(value, { expectedFarmId, now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  if (!value || typeof value !== 'object') throw new TypeError('Generation forecast must be an object');
  if (expectedFarmId && value.farmId !== expectedFarmId) throw new TypeError('Generation forecast farmId does not match the requested farm');
  requireTimestamp(value.generatedAt, 'generationForecast.generatedAt');
  if (Date.parse(value.generatedAt) > now + 60000) throw new TypeError('Generation forecast timestamp is in the future');
  if (now - Date.parse(value.generatedAt) > maxAgeMs) throw new TypeError('Generation forecast is stale');
  if (!Array.isArray(value.horizons)) throw new TypeError('Generation forecast horizons must be an array');
  validateSourceType(value.sourceType, 'generationForecast.sourceType');
  if (value.horizons.length !== FORECAST_HORIZONS.size) throw new TypeError('Generation forecast must include all five compatibility horizons');
  if (new Set(value.horizons.map(item => item.horizon)).size !== FORECAST_HORIZONS.size) throw new TypeError('Generation forecast horizons must be unique');
  if (value.status !== 'READY' && value.sourceType === 'WEATHER_DRIVEN_ENGINEERING_SIMULATION') throw new TypeError('Weather-driven generation simulation must be READY');
  if (value.source === 'MOCK_FALLBACK' && value.sourceType !== 'FALLBACK') throw new TypeError('Fallback generation data must use sourceType FALLBACK');
  for (const item of value.horizons) {
    if (!FORECAST_HORIZONS.has(item.horizon)) throw new TypeError(`Unsupported generation horizon: ${item.horizon}`);
    requireFinite(item.predictedGenerationMW, `${item.horizon}.predictedGenerationMW`, { min: 0 });
    requireFinite(item.lowerBoundMW, `${item.horizon}.lowerBoundMW`, { min: 0, nullable: true });
    requireFinite(item.upperBoundMW, `${item.horizon}.upperBoundMW`, { min: 0, nullable: true });
    if (item.lowerBoundMW !== null && item.upperBoundMW !== null && item.lowerBoundMW > item.upperBoundMW) throw new TypeError(`${item.horizon} forecast lower bound exceeds upper bound`);
  }
  return value;
}

function validateMarketForecast(value, { now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  if (!value || typeof value !== 'object') throw new TypeError('Market forecast must be an object');
  requireTimestamp(value.generatedAt, 'marketForecast.generatedAt');
  if (Date.parse(value.generatedAt) > now + 60000) throw new TypeError('Market forecast timestamp is in the future');
  if (now - Date.parse(value.generatedAt) > maxAgeMs) throw new TypeError('Market forecast is stale');
  requireFinite(value.currentPricePerMWh, 'currentPricePerMWh', { min: 0 });
  validateSourceType(value.sourceType, 'marketForecast.sourceType');
  if (value.source === 'MOCK_FALLBACK' && value.sourceType !== 'FALLBACK') throw new TypeError('Fallback market data must use sourceType FALLBACK');
  if (value.priceUnit && value.priceUnit !== 'INR_PER_MWH') throw new TypeError('Market price unit must be INR_PER_MWH');
  if (!Array.isArray(value.forecasts)) throw new TypeError('Market forecasts must be an array');
  for (const item of value.forecasts) requireFinite(item.predictedPricePerMWh, `${item.horizon}.predictedPricePerMWh`, { min: 0 });
  return value;
}

function assertFresh(timestamp, maxAgeMs, now = Date.now()) {
  requireTimestamp(timestamp, 'timestamp');
  requireFinite(maxAgeMs, 'maxAgeMs', { min: 1 });
  if (now - Date.parse(timestamp) > maxAgeMs) throw new TypeError('Input is stale');
  return true;
}

module.exports = {
  SOURCE_TYPES,
  FORECAST_HORIZONS,
  requireFinite,
  requireTimestamp,
  validateFarmId,
  validateFarmState,
  validateSourceType,
  validateGenerationForecast,
  validateMarketForecast,
  assertFresh,
};


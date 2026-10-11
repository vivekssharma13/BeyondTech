const { farms } = require('../api_dashboard_data');
const { getDatabase, json } = require('./database_service');
const { requireFinite, validateSourceType } = require('./validation_service');

const UNKNOWN = Object.freeze({ value: null, unit: null, sourceType: 'UNAVAILABLE', sourceRef: null });

function parameter(value, unit, sourceType, sourceRef, note = null) {
  return { value, unit, sourceType, sourceRef, note };
}

function generationSimulationDefaults() {
  return {
    weatherProvider: { value: 'OPEN_METEO', unit: null, sourceType: 'USER_CONFIGURED_SIMULATION', sourceRef: 'Phase 2A provider selection', note: 'Open-Meteo best-match forecast; retrieval time is recorded and issue time remains null when unavailable.' },
    modelVersion: { value: 'weather-engineering-v1', unit: null, sourceType: 'USER_CONFIGURED_SIMULATION', sourceRef: 'backend/services/generation_engineering_service.js' },
    farms: Object.fromEntries(farms.map(farm => [farm.farmId, {
      technology: { value: farm.type, unit: null, sourceType: 'USER_CONFIGURED_SIMULATION', sourceRef: 'backend/api_dashboard_data.js' },
      latitude: parameter(null, 'DEGREES', 'UNAVAILABLE', null),
      longitude: parameter(null, 'DEGREES', 'UNAVAILABLE', null),
      timezone: { value: null, unit: null, sourceType: 'UNAVAILABLE', sourceRef: null },
      elevationM: parameter(null, 'METERS', 'UNAVAILABLE', null),
      installedAcCapacityMW: parameter(farm.capacityMW, 'MW', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      availabilityPct: parameter(farm.availabilityPct, 'PERCENT', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      solar: farm.type === 'SOLAR' ? {
        panelTiltDeg: parameter(null, 'DEGREES', 'UNAVAILABLE', null),
        panelAzimuthDeg: parameter(null, 'DEGREES_CLOCKWISE_FROM_NORTH', 'UNAVAILABLE', null),
        dcAcRatio: parameter(null, 'RATIO', 'UNAVAILABLE', null),
        inverterEfficiency: parameter(null, 'RATIO', 'UNAVAILABLE', null),
        systemLossPct: parameter(null, 'PERCENT', 'UNAVAILABLE', null),
        temperatureCoefficientPctPerC: parameter(null, 'PERCENT_PER_C', 'UNAVAILABLE', null),
        nominalOperatingCellTemperatureC: parameter(null, 'CELSIUS', 'UNAVAILABLE', null),
        groundAlbedo: parameter(null, 'RATIO', 'UNAVAILABLE', null),
      } : null,
      wind: farm.type === 'WIND' ? {
        hubHeightM: parameter(null, 'METERS', 'UNAVAILABLE', null),
        turbineCount: parameter(null, 'COUNT', 'UNAVAILABLE', null),
        turbineRatedPowerMW: parameter(null, 'MW', 'UNAVAILABLE', null),
        cutInSpeedMps: parameter(null, 'M_PER_S', 'UNAVAILABLE', null),
        ratedSpeedMps: parameter(null, 'M_PER_S', 'UNAVAILABLE', null),
        cutOutSpeedMps: parameter(null, 'M_PER_S', 'UNAVAILABLE', null),
        windShearExponent: parameter(null, 'EXPONENT', 'UNAVAILABLE', null),
        referenceAirDensityKgM3: parameter(null, 'KG_PER_M3', 'UNAVAILABLE', null),
      } : null,
    }])),
  };
}

function initialConfiguration() {
  return {
    schemaVersion: 2,
    mode: 'SIMULATION',
    sharedFleetLimits: {
      gridImportCapacityMW: parameter(null, 'MW', 'UNAVAILABLE', null),
      gridExportCapacityMW: parameter(null, 'MW', 'UNAVAILABLE', null),
    },
    battery: {
      chargingEfficiency: parameter(0.92, 'RATIO', 'LEGACY_CODE_ASSUMPTION', 'backend/api_server.js (legacy); backend/services/audit_repository.js (current)', 'Used by accepted BUY state transition; not verified equipment data.'),
      dischargingEfficiency: parameter(0.92, 'RATIO', 'LEGACY_CODE_ASSUMPTION', 'backend/api_server.js (legacy); backend/services/audit_repository.js (current)', 'Used by accepted SELL state transition; not verified equipment data.'),
      degradationCostPerMWh: parameter(null, 'INR_PER_MWH', 'UNAVAILABLE', null),
    },
    economics: {
      marketTransactionFeePerMWh: parameter(null, 'INR_PER_MWH', 'UNAVAILABLE', null),
      importTariffPerMWh: parameter(null, 'INR_PER_MWH', 'UNAVAILABLE', null),
      exportTariffPerMWh: parameter(null, 'INR_PER_MWH', 'UNAVAILABLE', null),
    },
    optimization: {
      riskAssumptions: parameter(null, 'STRUCTURED_POLICY', 'UNAVAILABLE', null),
      strategyPresets: parameter(null, 'STRUCTURED_POLICY', 'UNAVAILABLE', null),
    },
    aiLimits: {
      maximumToolCalls: parameter(null, 'COUNT', 'UNAVAILABLE', null),
      maximumCostMinorUnits: parameter(null, 'INR_MINOR_UNITS', 'UNAVAILABLE', null),
      timeoutMs: parameter(null, 'MILLISECONDS', 'UNAVAILABLE', null),
      maximumOutputTokens: parameter(null, 'TOKENS', 'UNAVAILABLE', null),
      retryLimit: parameter(null, 'COUNT', 'UNAVAILABLE', null),
      allowDeterministicFallback: { value: false, unit: 'BOOLEAN', sourceType: 'LEGACY_CODE_ASSUMPTION', sourceRef: 'Safe fail-closed default', note: 'Must be explicitly enabled for demonstrations.' },
    },
    marketSimulation: {
      activeScenarioId: { value: null, unit: null, sourceType: 'UNAVAILABLE', sourceRef: null },
      scenarioVersion: parameter(null, 'VERSION', 'UNAVAILABLE', null),
      scenarios: {},
    },
    freshness: {
      generationForecastMaxAgeMs: parameter(3600000, 'MILLISECONDS', 'LEGACY_CODE_ASSUMPTION', 'Phase 1 validation policy', 'Explicit initial validation limit; configurable.'),
      marketForecastMaxAgeMs: parameter(3600000, 'MILLISECONDS', 'LEGACY_CODE_ASSUMPTION', 'Phase 1 validation policy', 'Explicit initial validation limit; configurable.'),
    },
    fallbackPolicy: {
      allowDegradedSimulation: { value: true, unit: 'BOOLEAN', sourceType: 'LEGACY_CODE_ASSUMPTION', sourceRef: 'backend/services/generation_service.js and backend/services/market_service.js', note: 'Preserves existing labeled fallback behavior; fallback output must remain visibly DEGRADED.' },
    },
    generationSimulation: generationSimulationDefaults(),
    farms: Object.fromEntries(farms.map(farm => [farm.farmId, {
      gridExportLimitMW: parameter(farm.gridExportLimitMW, 'MW', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      gridImportLimitMW: parameter(farm.gridImportLimitMW, 'MW', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      connectionExportCapacityMW: parameter(farm.connectionExportCapacityMW, 'MW', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      connectionImportCapacityMW: parameter(farm.connectionImportCapacityMW, 'MW', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      batteryCapacityMWh: parameter(farm.batteryCapacityMWh, 'MWh', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      batteryMaxPowerMW: parameter(farm.batteryMaxPowerMW, 'MW', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      batteryReservePct: parameter(farm.reservePct, 'PERCENT', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
      batterySafeChargePct: parameter(farm.batterySafeChargePct, 'PERCENT', 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js'),
    }])),
  };
}

function validateParameter(entry, path, { min = 0, max = Infinity, structured = false } = {}) {
  if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'value')) throw new TypeError(`${path} must be a parameter object`);
  validateSourceType(entry.sourceType, `${path}.sourceType`);
  if (entry.value === null) {
    if (entry.sourceType !== 'UNAVAILABLE') throw new TypeError(`${path} null values must use sourceType UNAVAILABLE`);
    return;
  }
  if (structured) {
    if (typeof entry.value !== 'object' || Array.isArray(entry.value)) throw new TypeError(`${path}.value must be a structured object or null`);
  } else requireFinite(entry.value, `${path}.value`, { min, max });
  if (entry.sourceType === 'UNAVAILABLE') throw new TypeError(`${path} numeric values cannot use sourceType UNAVAILABLE`);
}

function validateTextParameter(entry, path, { allowed = null } = {}) {
  if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'value')) throw new TypeError(`${path} must be a parameter object`);
  validateSourceType(entry.sourceType, `${path}.sourceType`);
  if (entry.value === null) {
    if (entry.sourceType !== 'UNAVAILABLE') throw new TypeError(`${path} null values must use sourceType UNAVAILABLE`);
    return;
  }
  if (typeof entry.value !== 'string' || !entry.value.trim()) throw new TypeError(`${path}.value must be a non-empty string or null`);
  if (allowed && !allowed.includes(entry.value)) throw new TypeError(`${path}.value must be one of ${allowed.join(', ')}`);
  if (entry.sourceType === 'UNAVAILABLE') throw new TypeError(`${path} configured values cannot use sourceType UNAVAILABLE`);
}

function validateGenerationSimulation(config) {
  const generation = config.generationSimulation;
  if (!generation || typeof generation !== 'object') throw new TypeError('generationSimulation configuration is required');
  validateTextParameter(generation.weatherProvider, 'generationSimulation.weatherProvider', { allowed: ['OPEN_METEO'] });
  validateTextParameter(generation.modelVersion, 'generationSimulation.modelVersion');
  for (const farm of farms) {
    const values = generation.farms?.[farm.farmId];
    if (!values) throw new TypeError(`generationSimulation.farms.${farm.farmId} is required`);
    validateTextParameter(values.technology, `generationSimulation.farms.${farm.farmId}.technology`, { allowed: [farm.type] });
    validateParameter(values.latitude, `generationSimulation.farms.${farm.farmId}.latitude`, { min: -90, max: 90 });
    validateParameter(values.longitude, `generationSimulation.farms.${farm.farmId}.longitude`, { min: -180, max: 180 });
    validateTextParameter(values.timezone, `generationSimulation.farms.${farm.farmId}.timezone`);
    validateParameter(values.elevationM, `generationSimulation.farms.${farm.farmId}.elevationM`, { min: -500, max: 9000 });
    validateParameter(values.installedAcCapacityMW, `generationSimulation.farms.${farm.farmId}.installedAcCapacityMW`, { min: 0.1 });
    validateParameter(values.availabilityPct, `generationSimulation.farms.${farm.farmId}.availabilityPct`, { min: 0, max: 100 });
    const equipment = farm.type === 'SOLAR' ? values.solar : values.wind;
    if (!equipment) throw new TypeError(`generationSimulation.farms.${farm.farmId}.${farm.type.toLowerCase()} is required`);
    for (const [name, entry] of Object.entries(equipment)) {
      const ranges = {
        panelTiltDeg: [0, 90], panelAzimuthDeg: [0, 360], dcAcRatio: [0.1, 3], inverterEfficiency: [0.1, 1], systemLossPct: [0, 100],
        temperatureCoefficientPctPerC: [-5, 0], nominalOperatingCellTemperatureC: [20, 80], groundAlbedo: [0, 1],
        hubHeightM: [10, 300], turbineCount: [1, 10000], turbineRatedPowerMW: [0.01, 50], cutInSpeedMps: [0, 20], ratedSpeedMps: [0.1, 30],
        cutOutSpeedMps: [0.1, 60], windShearExponent: [0, 1], referenceAirDensityKgM3: [0.5, 2],
      };
      validateParameter(entry, `generationSimulation.farms.${farm.farmId}.${farm.type.toLowerCase()}.${name}`, { min: ranges[name][0], max: ranges[name][1] });
    }
    if (farm.type === 'WIND' && [equipment.cutInSpeedMps.value, equipment.ratedSpeedMps.value, equipment.cutOutSpeedMps.value].every(Number.isFinite)) {
      if (!(equipment.cutInSpeedMps.value < equipment.ratedSpeedMps.value && equipment.ratedSpeedMps.value < equipment.cutOutSpeedMps.value)) {
        throw new TypeError(`generationSimulation.farms.${farm.farmId}.wind speeds must satisfy cut-in < rated < cut-out`);
      }
      if (!Number.isInteger(equipment.turbineCount.value)) throw new TypeError(`generationSimulation.farms.${farm.farmId}.wind.turbineCount must be an integer`);
    }
  }
}

function validateConfiguration(config) {
  if (!config || config.schemaVersion !== 2 || config.mode !== 'SIMULATION') throw new TypeError('Configuration must use schemaVersion 2 and SIMULATION mode');
  validateParameter(config.sharedFleetLimits.gridImportCapacityMW, 'sharedFleetLimits.gridImportCapacityMW');
  validateParameter(config.sharedFleetLimits.gridExportCapacityMW, 'sharedFleetLimits.gridExportCapacityMW');
  validateParameter(config.battery.chargingEfficiency, 'battery.chargingEfficiency', { min: Number.EPSILON, max: 1 });
  validateParameter(config.battery.dischargingEfficiency, 'battery.dischargingEfficiency', { min: Number.EPSILON, max: 1 });
  validateParameter(config.battery.degradationCostPerMWh, 'battery.degradationCostPerMWh');
  validateParameter(config.economics.marketTransactionFeePerMWh, 'economics.marketTransactionFeePerMWh');
  validateParameter(config.economics.importTariffPerMWh, 'economics.importTariffPerMWh');
  validateParameter(config.economics.exportTariffPerMWh, 'economics.exportTariffPerMWh');
  validateParameter(config.optimization.riskAssumptions, 'optimization.riskAssumptions', { structured: true });
  validateParameter(config.optimization.strategyPresets, 'optimization.strategyPresets', { structured: true });
  validateParameter(config.aiLimits.maximumToolCalls, 'aiLimits.maximumToolCalls', { min: 1, max: 3 });
  validateParameter(config.aiLimits.maximumCostMinorUnits, 'aiLimits.maximumCostMinorUnits', { min: 1 });
  validateParameter(config.aiLimits.timeoutMs, 'aiLimits.timeoutMs', { min: 100 });
  validateParameter(config.aiLimits.maximumOutputTokens, 'aiLimits.maximumOutputTokens', { min: 256 });
  validateParameter(config.aiLimits.retryLimit, 'aiLimits.retryLimit', { min: 0, max: 3 });
  for (const name of ['maximumToolCalls', 'maximumCostMinorUnits', 'timeoutMs', 'maximumOutputTokens', 'retryLimit']) {
    const configuredValue = config.aiLimits[name].value;
    if (configuredValue !== null && !Number.isInteger(configuredValue)) throw new TypeError(`aiLimits.${name}.value must be an integer`);
  }
  if (typeof config.aiLimits.allowDeterministicFallback?.value !== 'boolean') throw new TypeError('aiLimits.allowDeterministicFallback.value must be boolean');
  validateSourceType(config.aiLimits.allowDeterministicFallback.sourceType, 'aiLimits.allowDeterministicFallback.sourceType');
  validateTextParameter(config.marketSimulation.activeScenarioId, 'marketSimulation.activeScenarioId');
  validateParameter(config.marketSimulation.scenarioVersion, 'marketSimulation.scenarioVersion', { min: 1 });
  if (!config.marketSimulation.scenarios || typeof config.marketSimulation.scenarios !== 'object' || Array.isArray(config.marketSimulation.scenarios)) throw new TypeError('marketSimulation.scenarios must be an object');
  if (config.marketSimulation.activeScenarioId.value !== null && !config.marketSimulation.scenarios[config.marketSimulation.activeScenarioId.value]) throw new TypeError('marketSimulation.activeScenarioId must reference a configured scenario');
  for (const [scenarioId, scenario] of Object.entries(config.marketSimulation.scenarios)) {
    if (!scenario || typeof scenario !== 'object' || typeof scenario.displayName !== 'string' || !scenario.displayName.trim()) throw new TypeError(`marketSimulation.scenarios.${scenarioId} must have a displayName`);
    for (const name of ['basePriceINRPerMWh', 'demandAmplitude', 'renewableInfluence', 'peakPremium', 'scarcityPremium', 'volatility', 'phase']) requireFinite(scenario[name], `marketSimulation.scenarios.${scenarioId}.${name}`, { min: name === 'phase' ? -Infinity : 0 });
    if (!Array.isArray(scenario.events)) throw new TypeError(`marketSimulation.scenarios.${scenarioId}.events must be an array`);
    for (const [index, event] of scenario.events.entries()) {
      requireFinite(event.startHour, `marketSimulation.scenarios.${scenarioId}.events.${index}.startHour`, { min: 0, max: 71 });
      requireFinite(event.durationHours, `marketSimulation.scenarios.${scenarioId}.events.${index}.durationHours`, { min: 0.25, max: 72 });
      requireFinite(event.priceAdderINRPerMWh, `marketSimulation.scenarios.${scenarioId}.events.${index}.priceAdderINRPerMWh`);
      if (typeof event.label !== 'string' || !event.label.trim()) throw new TypeError(`marketSimulation.scenarios.${scenarioId}.events.${index}.label is required`);
    }
  }
  validateParameter(config.freshness.generationForecastMaxAgeMs, 'freshness.generationForecastMaxAgeMs', { min: 1 });
  validateParameter(config.freshness.marketForecastMaxAgeMs, 'freshness.marketForecastMaxAgeMs', { min: 1 });
  if (typeof config.fallbackPolicy?.allowDegradedSimulation?.value !== 'boolean') throw new TypeError('fallbackPolicy.allowDegradedSimulation.value must be boolean');
  validateSourceType(config.fallbackPolicy.allowDegradedSimulation.sourceType, 'fallbackPolicy.allowDegradedSimulation.sourceType');
  for (const [farmId, values] of Object.entries(config.farms || {})) {
    for (const [name, entry] of Object.entries(values)) validateParameter(entry, `farms.${farmId}.${name}`, { min: 0, max: name.endsWith('Pct') ? 100 : Infinity });
  }
  validateGenerationSimulation(config);
  return config;
}

function getActiveConfiguration() {
  const row = getDatabase().prepare("SELECT * FROM simulation_config_versions WHERE status='ACTIVE' ORDER BY config_version DESC LIMIT 1").get();
  if (!row) return createConfigurationVersion(initialConfiguration(), { createdBy: 'SYSTEM_BOOTSTRAP', sourceType: 'LEGACY_CODE_ASSUMPTION' });
  let configuration = JSON.parse(row.configuration_json);
  let migrated = false;
  if (configuration.schemaVersion === 1) {
    configuration = {
      ...configuration,
      schemaVersion: 2,
      optimization: { riskAssumptions: { ...configuration.optimization.riskAssumptions, unit: configuration.optimization.riskAssumptions.unit || 'STRUCTURED_POLICY' } },
      fallbackPolicy: {
        allowDegradedSimulation: { value: true, unit: 'BOOLEAN', sourceType: 'LEGACY_CODE_ASSUMPTION', sourceRef: 'backend/services/generation_service.js and backend/services/market_service.js', note: 'Preserves existing labeled fallback behavior; fallback output must remain visibly DEGRADED.' },
      },
    };
    migrated = true;
  }
  if (!configuration.generationSimulation) {
    configuration = { ...configuration, generationSimulation: generationSimulationDefaults() };
    migrated = true;
  }
  const defaults = initialConfiguration();
  if (!configuration.marketSimulation || !configuration.optimization?.strategyPresets || !configuration.aiLimits?.maximumOutputTokens) {
    configuration = {
      ...configuration,
      optimization: { ...configuration.optimization, strategyPresets: configuration.optimization?.strategyPresets || defaults.optimization.strategyPresets },
      aiLimits: {
        ...defaults.aiLimits,
        ...configuration.aiLimits,
      },
      marketSimulation: configuration.marketSimulation || defaults.marketSimulation,
    };
    migrated = true;
  }
  if (migrated) return createConfigurationVersion(configuration, { createdBy: 'SYSTEM_CONFIG_MIGRATION', sourceType: 'LEGACY_CODE_ASSUMPTION' });
  return { configVersion: Number(row.config_version), status: row.status, sourceType: row.source_type, createdAt: row.created_at, configuration };
}

function missingGenerationSimulationParameters(config, farmId) {
  const values = config.generationSimulation?.farms?.[farmId];
  if (!values) return [`generationSimulation.farms.${farmId}`];
  const entries = [
    ['latitude', values.latitude], ['longitude', values.longitude], ['timezone', values.timezone], ['elevationM', values.elevationM],
    ['installedAcCapacityMW', values.installedAcCapacityMW], ['availabilityPct', values.availabilityPct],
    ...Object.entries(values.technology?.value === 'SOLAR' ? values.solar || {} : values.wind || {}),
  ];
  return entries.filter(([, entry]) => entry?.value === null || entry?.value === undefined).map(([name]) => `generationSimulation.farms.${farmId}.${name}`);
}

function resolvedGenerationFarmConfiguration(config, farmId) {
  const missing = missingGenerationSimulationParameters(config, farmId);
  if (missing.length) return { status: 'INCOMPLETE_SIMULATION_CONFIG', missing, configuration: null };
  const values = config.generationSimulation.farms[farmId];
  const unwrap = object => Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, entry.value]));
  return {
    status: 'READY',
    missing: [],
    configuration: {
      farmId,
      technology: values.technology.value,
      latitude: values.latitude.value,
      longitude: values.longitude.value,
      timezone: values.timezone.value,
      elevation: values.elevationM.value,
      installedAcCapacityMW: values.installedAcCapacityMW.value,
      availabilityPct: values.availabilityPct.value,
      ...unwrap(values.technology.value === 'SOLAR' ? values.solar : values.wind),
    },
  };
}

function createConfigurationVersion(configuration, { createdBy = 'OPERATOR', sourceType = 'USER_CONFIGURED_SIMULATION' } = {}) {
  validateConfiguration(configuration);
  validateSourceType(sourceType);
  const db = getDatabase();
  const previous = db.prepare("SELECT config_version FROM simulation_config_versions WHERE status='ACTIVE' ORDER BY config_version DESC LIMIT 1").get();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE simulation_config_versions SET status='SUPERSEDED' WHERE status='ACTIVE'").run();
    const createdAt = new Date().toISOString();
    const result = db.prepare(`INSERT INTO simulation_config_versions
      (status, source_type, configuration_json, created_at, created_by, supersedes_version)
      VALUES ('ACTIVE', ?, ?, ?, ?, ?)`)
      .run(sourceType, json(configuration), createdAt, createdBy, previous?.config_version ?? null);
    db.exec('COMMIT');
    return { configVersion: Number(result.lastInsertRowid), status: 'ACTIVE', sourceType, createdAt, configuration };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function missingEconomicAssumptions(config = getActiveConfiguration().configuration) {
  const checks = [
    ['sharedFleetLimits.gridImportCapacityMW', config.sharedFleetLimits.gridImportCapacityMW],
    ['sharedFleetLimits.gridExportCapacityMW', config.sharedFleetLimits.gridExportCapacityMW],
    ['battery.degradationCostPerMWh', config.battery.degradationCostPerMWh],
    ['economics.marketTransactionFeePerMWh', config.economics.marketTransactionFeePerMWh],
    ['economics.importTariffPerMWh', config.economics.importTariffPerMWh],
    ['economics.exportTariffPerMWh', config.economics.exportTariffPerMWh],
    ['optimization.riskAssumptions', config.optimization.riskAssumptions],
    ['optimization.strategyPresets', config.optimization.strategyPresets],
  ];
  return checks.filter(([, entry]) => entry?.value === null).map(([name]) => name);
}

function missingDecisionAgentAssumptions(config = getActiveConfiguration().configuration) {
  const checks = [
    ['aiLimits.maximumToolCalls', config.aiLimits.maximumToolCalls],
    ['aiLimits.maximumCostMinorUnits', config.aiLimits.maximumCostMinorUnits],
    ['aiLimits.timeoutMs', config.aiLimits.timeoutMs],
    ['aiLimits.maximumOutputTokens', config.aiLimits.maximumOutputTokens],
    ['aiLimits.retryLimit', config.aiLimits.retryLimit],
  ];
  return checks.filter(([, entry]) => entry?.value === null).map(([name]) => name);
}

module.exports = {
  UNKNOWN,
  parameter,
  initialConfiguration,
  validateConfiguration,
  getActiveConfiguration,
  createConfigurationVersion,
  missingEconomicAssumptions,
  missingDecisionAgentAssumptions,
  missingGenerationSimulationParameters,
  resolvedGenerationFarmConfiguration,
};


const fs = require('fs');
const path = require('path');
const { createBucketCache } = require('./cache_service');
const { createId, recordAgentRun, recordActivity } = require('./runtime_store');
const { runJsonProcess } = require('./subprocess_service');
const { startComponent, completeComponent, failComponent, cacheObserver } = require('./workflow_service');
const { getActiveConfiguration, resolvedGenerationFarmConfiguration } = require('./configuration_service');
const { createOpenMeteoService, PROVIDER } = require('./open_meteo_service');
const { MODEL_VERSION, SOURCE_TYPE, calculateGenerationMW } = require('./generation_engineering_service');

const ROOT = path.resolve(__dirname, '..', '..');
const MODEL_SCRIPT = path.join(ROOT, 'model', 'predict.py');
const DEFAULT_PYTHON = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python')) ? path.join(ROOT, '.venv', 'bin', 'python') : 'python3';
const SUMMARY_HOURS = [1, 6, 24, 48, 72];
const REQUIRED_WEATHER = Object.freeze({
  SOLAR: ['shortwave_radiation', 'direct_normal_irradiance', 'diffuse_radiation', 'temperature_2m', 'is_day'],
  WIND: ['wind_speed_80m', 'wind_speed_120m', 'temperature_2m', 'surface_pressure'],
});

function runPrediction(body, { python = DEFAULT_PYTHON, script = MODEL_SCRIPT } = {}) {
  return runJsonProcess({
    command: python, args: [script], cwd: path.dirname(script), input: body,
    timeoutMs: process.env.GENERATION_PROCESS_TIMEOUT_MS || process.env.PYTHON_PROCESS_TIMEOUT_MS || 30000,
    maxOutputBytes: process.env.PYTHON_MAX_OUTPUT_BYTES || 1048576,
    retries: Number(process.env.GENERATION_PROCESS_RETRIES || 0),
  }).then(result => result.data);
}

function validateWeatherIntervals(weather, farmType) {
  if (!Array.isArray(weather?.intervals) || weather.intervals.length !== 72) {
    const error = new Error(`Open-Meteo returned ${weather?.intervals?.length || 0} valid future hours; exactly 72 are required`);
    error.code = 'INCOMPLETE_WEATHER_FORECAST';
    throw error;
  }
  for (let index = 0; index < weather.intervals.length; index += 1) {
    const row = weather.intervals[index];
    const expected = index === 0 ? null : Date.parse(weather.intervals[index - 1].validAt) + 3600000;
    if (!Number.isFinite(Date.parse(row.validAt)) || (expected !== null && Date.parse(row.validAt) !== expected)) {
      const error = new Error(`Weather forecast is not continuous at interval ${index + 1}`);
      error.code = 'INCOMPLETE_WEATHER_FORECAST';
      throw error;
    }
    const missing = REQUIRED_WEATHER[farmType].filter(field => row[field] === null || row[field] === undefined || !Number.isFinite(Number(row[field])));
    if (missing.length) {
      const error = new Error(`Weather interval ${index + 1} is missing: ${missing.join(', ')}`);
      error.code = 'WEATHER_VARIABLE_MISSING';
      throw error;
    }
  }
}

function unavailableResponse({ farm, status, generatedAt, configVersion, error, missing = [] }) {
  return {
    agent: 'GENERATION_FORECAST', agentRunId: createId('generation-run'), status, forecastStatus: status,
    farmId: farm.farmId, generatedAt, source: 'UNAVAILABLE', sourceType: 'UNAVAILABLE', weatherInputSource: null,
    modelVersion: MODEL_VERSION, configurationVersion: String(configVersion), intervals: [], horizons: [],
    diagnostics: { code: error?.code || status, message: error?.message || 'Simulation configuration is incomplete.', missing }, drivers: [],
  };
}

function createGenerationService({ weatherService = createOpenMeteoService(), cache = createBucketCache(), now = () => Date.now(), configurationProvider = getActiveConfiguration } = {}) {
  const previousByFarm = new Map();

  async function execute(farm, { refresh = false, workflowId = null } = {}) {
    const startedAt = now();
    const generatedAt = new Date(startedAt).toISOString();
    const active = configurationProvider();
    const resolved = resolvedGenerationFarmConfiguration(active.configuration, farm.farmId);
    const agentRunId = createId('generation-run');
    const execution = startComponent({
      workflowId, component: 'GENERATION_SIMULATION', sourceType: SOURCE_TYPE,
      modelName: farm.type === 'SOLAR' ? 'DETERMINISTIC_PV_MODEL' : 'DETERMINISTIC_WIND_POWER_CURVE', modelVersion: MODEL_VERSION,
      input: { farmId: farm.farmId, farmType: farm.type, configurationVersion: active.configVersion, requestedIntervals: 72 },
    });
    let response;
    if (resolved.status !== 'READY') {
      response = unavailableResponse({ farm, status: resolved.status, generatedAt, configVersion: active.configVersion, missing: resolved.missing });
      response.agentRunId = agentRunId;
      completeComponent(execution, { status: resolved.status, sourceType: 'UNAVAILABLE', output: { farmId: farm.farmId, validIntervals: 0, missing: resolved.missing } });
    } else {
      try {
        const config = resolved.configuration;
        const weather = await weatherService.getForecast({ latitude: config.latitude, longitude: config.longitude, elevation: config.elevation }, { refresh, workflowId });
        validateWeatherIntervals(weather, farm.type);
        const intervals = weather.intervals.map(row => {
          const intervalEnd = new Date(row.validAt).toISOString();
          return {
            intervalStart: new Date(Date.parse(intervalEnd) - 3600000).toISOString(), intervalEnd,
            predictedGenerationMW: calculateGenerationMW(farm.type, row, config), sourceType: SOURCE_TYPE,
            weatherSource: PROVIDER, modelVersion: MODEL_VERSION, configurationVersion: String(active.configVersion),
          };
        });
        const previous = previousByFarm.get(farm.farmId);
        const horizons = SUMMARY_HOURS.map(hours => {
          const interval = intervals[hours - 1];
          const old = previous?.horizons?.find(item => item.horizon === `${hours}h`);
          return {
            horizon: `${hours}h`, validAt: interval.intervalEnd, predictedGenerationMW: Number(interval.predictedGenerationMW.toFixed(1)),
            lowerBoundMW: null, upperBoundMW: null, confidencePct: null, uncertaintyStatus: 'UNAVAILABLE_NOT_CALIBRATED',
            changePct: old?.predictedGenerationMW ? Number(((interval.predictedGenerationMW - old.predictedGenerationMW) / old.predictedGenerationMW * 100).toFixed(1)) : null,
          };
        });
        response = {
          agent: 'GENERATION_FORECAST', agentRunId, status: 'READY', forecastStatus: 'READY', farmId: farm.farmId, generatedAt,
          nextRunAt: new Date((Math.floor(startedAt / 900000) + 1) * 900000).toISOString(),
          cacheExpiresAt: new Date((Math.floor(startedAt / 900000) + 1) * 900000).toISOString(), scheduled: false, nextScheduledRunAt: null,
          source: SOURCE_TYPE, sourceType: SOURCE_TYPE, weatherInputSource: PROVIDER, modelVersion: MODEL_VERSION,
          configurationVersion: String(active.configVersion), previousAgentRunId: previous?.agentRunId || null,
          weather: {
            provider: weather.provider, weatherModel: weather.weatherModel, requestedCoordinates: weather.requestedCoordinates,
            returnedCoordinates: weather.returnedCoordinates, retrievedAt: weather.retrievedAt, forecastIssuedAt: weather.forecastIssuedAt,
            freshnessMs: Math.max(0, startedAt - Date.parse(weather.retrievedAt)), units: weather.units,
          },
          intervals, horizons,
          drivers: farm.type === 'SOLAR'
            ? ['Future hourly irradiance, solar position, temperature derating, configured PV equipment and availability drive this engineering simulation.']
            : ['Future hub-height wind, the configured turbine power curve, air density and availability drive this engineering simulation.'],
          accuracyStatus: 'UNAVAILABLE_NOT_VALIDATED_AGAINST_MEASURED_FARM_OUTPUT', diagnostics: { validIntervals: intervals.length },
        };
        completeComponent(execution, { status: 'COMPLETED', sourceType: SOURCE_TYPE, output: { farmId: farm.farmId, validIntervals: 72, configurationVersion: active.configVersion, modelVersion: MODEL_VERSION } });
        previousByFarm.set(farm.farmId, response);
      } catch (error) {
        failComponent(execution, error, { farmId: farm.farmId, configurationVersion: active.configVersion });
        const status = ['INCOMPLETE_WEATHER_FORECAST', 'WEATHER_VARIABLE_MISSING'].includes(error.code) ? 'DEGRADED' : 'UNAVAILABLE';
        response = unavailableResponse({ farm, status, generatedAt, configVersion: active.configVersion, error });
        response.agentRunId = agentRunId;
      }
    }
    recordAgentRun({ agent: 'GENERATION_FORECAST', agentRunId, farmId: farm.farmId, status: response.status, source: response.source, generatedAt });
    recordActivity({ type: 'GENERATION_SIMULATION_UPDATED', farmId: farm.farmId, message: `${farm.name} weather-driven generation simulation status: ${response.status}.` });
    return response;
  }

  function getForecast(farm, { refresh = false, workflowId = null } = {}) {
    const active = configurationProvider();
    return cache.getOrCreate(`generation:${farm.farmId}:config-${active.configVersion}`, () => execute(farm, { refresh, workflowId }), {
      refresh, now: now(), observe: cacheObserver(workflowId, 'GENERATION_SIMULATION'),
    });
  }

  return { getForecast, runPrediction, cache };
}

module.exports = { createGenerationService, runPrediction, validateWeatherIntervals, SUMMARY_HOURS, REQUIRED_WEATHER };

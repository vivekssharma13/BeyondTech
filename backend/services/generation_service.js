const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { forecastFor } = require('../api_dashboard_data');
const { createBucketCache } = require('./cache_service');
const { createId, recordAgentRun, recordActivity } = require('./runtime_store');

const ROOT = path.resolve(__dirname, '..', '..');
const MODEL_SCRIPT = path.join(ROOT, 'model', 'predict.py');
const DEFAULT_PYTHON = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python'))
  ? path.join(ROOT, '.venv', 'bin', 'python')
  : 'python3';
const HORIZONS = [1, 6, 24, 48, 72];

function runPrediction(body, { python = DEFAULT_PYTHON, script = MODEL_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { cwd: path.dirname(script) });
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        reject(new Error(error.trim() || 'Prediction process returned invalid JSON'));
        return;
      }
      if (code !== 0 || parsed.error) reject(new Error(parsed.error || error.trim() || 'Prediction failed'));
      else resolve(parsed);
    });
    child.stdin.end(JSON.stringify(body));
  });
}

function round(value) {
  return Number(value.toFixed(1));
}

function modelValueToFarmMW(value, farm) {
  // The shared model is trained on a normalized 0-1000 reference plant. Scale
  // that capacity factor to each farm and enforce its available capacity.
  const availableCapacity = farm.capacityMW * farm.availabilityPct / 100;
  return Math.min(availableCapacity, Math.max(0, Number(value) / 1000 * farm.capacityMW));
}

function toHorizon(raw, farm, hours) {
  const target = farm.type === 'SOLAR' ? 'solar_power' : 'wind_power';
  const requiredValues = [raw[target], raw[`${target}_lower`], raw[`${target}_upper`], raw[`${target}_confidence`]].map(Number);
  if (!requiredValues.every(Number.isFinite)) throw new Error(`Prediction result is missing valid ${target} fields`);
  const confidence = Number(raw[`${target}_confidence`]);
  return {
    horizon: `${hours}h`,
    predictedGenerationMW: round(modelValueToFarmMW(raw[target], farm)),
    lowerBoundMW: round(modelValueToFarmMW(raw[`${target}_lower`], farm)),
    upperBoundMW: round(modelValueToFarmMW(raw[`${target}_upper`], farm)),
    confidencePct: Math.round(Number.isFinite(confidence) ? confidence : 0),
  };
}

function defaultDrivers(farm, results) {
  const first = results[0];
  const sixth = results[1];
  const direction = sixth.predictedGenerationMW >= first.predictedGenerationMW ? 'increase' : 'decline';
  return farm.type === 'SOLAR'
    ? [`Solar output is expected to ${direction} over the next 6 hours.`, 'The forecast uses weather data and current farm availability.']
    : [`Wind output is expected to ${direction} over the next 6 hours.`, 'The forecast uses wind conditions and current turbine availability.'];
}

function predictionInputsForFarm(farm) {
  if (farm.type !== 'WIND' || !Number.isFinite(farm.weather?.windSpeedMps)) return undefined;
  const speedMps = farm.weather.windSpeedMps;
  const gustMps = Number.isFinite(farm.weather.windGustMps) ? farm.weather.windGustMps : speedMps * 1.25;
  return {
    // predict.py expects the units declared by solarAndWindData.json (km/h).
    // Approximate hub-height values from the farm's existing simulated wind
    // telemetry instead of borrowing an unrelated Bengaluru historical row.
    wind_speed_10m: speedMps * 3.6 * 0.72,
    wind_speed_80m: speedMps * 3.6,
    wind_speed_120m: speedMps * 3.6 * 1.06,
    wind_gusts_10m: gustMps * 3.6,
    wind_direction_10m: farm.weather.windDirectionDeg,
    wind_direction_80m: farm.weather.windDirectionDeg,
    temperature_2m: farm.weather.temperatureC,
  };
}

function createGenerationService({
  predictionRunner = runPrediction,
  cache = createBucketCache(),
  now = () => Date.now(),
} = {}) {
  const previousByFarm = new Map();

  async function execute(farm) {
    const startedAt = now();
    const agentRunId = createId('generation-run');
    let response;
    let failure;
    try {
      const rawResults = await Promise.all(HORIZONS.map(hours => predictionRunner({
        // predict.py compares against timezone-naive training timestamps.
        date: new Date(startedAt + hours * 60 * 60 * 1000).toISOString().slice(0, 16),
        inputs: predictionInputsForFarm(farm),
      })));
      const horizons = rawResults.map((raw, index) => toHorizon(raw, farm, HORIZONS[index]));
      const previous = previousByFarm.get(farm.farmId);
      const withChanges = horizons.map(item => {
        const old = previous?.horizons?.find(entry => entry.horizon === item.horizon);
        const changePct = old?.predictedGenerationMW
          ? round((item.predictedGenerationMW - old.predictedGenerationMW) / old.predictedGenerationMW * 100)
          : null;
        return { ...item, changePct };
      });
      response = {
        agent: 'GENERATION_FORECAST',
        agentRunId,
        status: 'COMPLETED',
        farmId: farm.farmId,
        generatedAt: new Date(startedAt).toISOString(),
        nextRunAt: new Date((Math.floor(startedAt / 900000) + 1) * 900000).toISOString(),
        source: 'MODEL_WITH_HISTORICAL_INPUTS',
        weatherInputSource: farm.type === 'WIND' ? 'SIMULATED_FARM_WEATHER_WITH_HISTORICAL_DEFAULTS' : 'HISTORICAL_DATASET',
        previousAgentRunId: previous?.agentRunId || null,
        horizons: withChanges,
        drivers: defaultDrivers(farm, horizons),
      };
    } catch (error) {
      failure = error;
      const fallback = forecastFor(farm);
      response = {
        ...fallback,
        agentRunId,
        generatedAt: new Date(startedAt).toISOString(),
        nextRunAt: new Date((Math.floor(startedAt / 900000) + 1) * 900000).toISOString(),
        source: 'MOCK_FALLBACK',
      };
    }

    recordAgentRun({
      agent: 'GENERATION_FORECAST',
      agentRunId,
      farmId: farm.farmId,
      status: response.status,
      source: response.source,
      generatedAt: response.generatedAt,
      nextRunAt: response.nextRunAt,
      error: failure?.message,
    });
    recordActivity({
      type: 'GENERATION_FORECAST_UPDATED',
      farmId: farm.farmId,
      message: `${farm.name} generation forecast updated from ${response.source}.`,
    });
    previousByFarm.set(farm.farmId, response);
    return response;
  }

  function getForecast(farm, { refresh = false } = {}) {
    const currentTime = now();
    return cache.getOrCreate(`generation:${farm.farmId}`, () => execute(farm), { refresh, now: currentTime });
  }

  return { getForecast, runPrediction: predictionRunner, cache };
}

module.exports = { createGenerationService, runPrediction, modelValueToFarmMW, toHorizon, predictionInputsForFarm };

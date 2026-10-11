const { createBucketCache } = require('./cache_service');
const { startComponent, completeComponent, failComponent, cacheObserver } = require('./workflow_service');

const PROVIDER = 'OPEN_METEO';
const WEATHER_MODEL = 'BEST_MATCH';
const BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY_VARIABLES = Object.freeze([
  'shortwave_radiation',
  'direct_radiation',
  'direct_normal_irradiance',
  'diffuse_radiation',
  'temperature_2m',
  'cloud_cover',
  'is_day',
  'wind_speed_80m',
  'wind_speed_120m',
  'surface_pressure',
  'wind_direction_80m',
]);

function utcTimestamp(value) {
  if (typeof value !== 'string') return null;
  const withZone = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeResponse(payload, { latitude, longitude, elevation, retrievedAt, now }) {
  if (!payload || typeof payload !== 'object' || !payload.hourly || !Array.isArray(payload.hourly.time)) {
    const error = new Error('Open-Meteo response is missing hourly timestamps');
    error.code = 'WEATHER_RESPONSE_INVALID';
    throw error;
  }
  // Open-Meteo's hourly radiation value is the mean for the preceding hour.
  // Select the first value whose complete interval starts at or after retrieval.
  const firstFutureIntervalEnd = Math.floor(now / 3600000) * 3600000 + 2 * 3600000;
  const rows = payload.hourly.time.map((time, index) => {
    const validAt = utcTimestamp(time);
    const row = { validAt };
    for (const variable of HOURLY_VARIABLES) row[variable] = payload.hourly[variable]?.[index];
    return row;
  }).filter(row => row.validAt && Date.parse(row.validAt) >= firstFutureIntervalEnd).slice(0, 72);
  return {
    provider: PROVIDER,
    weatherModel: WEATHER_MODEL,
    requestedCoordinates: { latitude, longitude, elevation },
    returnedCoordinates: { latitude: payload.latitude ?? null, longitude: payload.longitude ?? null, elevation: payload.elevation ?? null },
    retrievedAt,
    forecastIssuedAt: null,
    timezone: payload.timezone || 'GMT',
    utcOffsetSeconds: payload.utc_offset_seconds ?? 0,
    units: payload.hourly_units || {},
    intervals: rows,
  };
}

function createOpenMeteoService({ fetcher = global.fetch, cache = createBucketCache(), now = () => Date.now(), baseUrl = BASE_URL } = {}) {
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required for Open-Meteo');

  async function fetchForecast(location, workflowId) {
    const execution = startComponent({
      workflowId,
      component: 'WEATHER_FORECAST',
      sourceType: 'MODEL_PREDICTION',
      modelName: PROVIDER,
      modelVersion: WEATHER_MODEL,
      input: { latitude: location.latitude, longitude: location.longitude, elevation: location.elevation, forecastHoursRequested: 96, variables: HOURLY_VARIABLES },
    });
    const retrievedAt = new Date(now()).toISOString();
    try {
      const url = new URL(baseUrl);
      url.searchParams.set('latitude', String(location.latitude));
      url.searchParams.set('longitude', String(location.longitude));
      if (Number.isFinite(location.elevation)) url.searchParams.set('elevation', String(location.elevation));
      url.searchParams.set('hourly', HOURLY_VARIABLES.join(','));
      url.searchParams.set('forecast_hours', '96');
      url.searchParams.set('timezone', 'GMT');
      url.searchParams.set('wind_speed_unit', 'ms');
      url.searchParams.set('models', 'best_match');
      const response = await fetcher(url, { signal: AbortSignal.timeout(Number(process.env.WEATHER_API_TIMEOUT_MS || 10000)) });
      if (!response.ok) {
        const error = new Error(`Open-Meteo request failed with HTTP ${response.status}`);
        error.code = 'WEATHER_PROVIDER_FAILED';
        throw error;
      }
      const result = normalizeResponse(await response.json(), { ...location, retrievedAt, now: now() });
      completeComponent(execution, { sourceType: 'MODEL_PREDICTION', output: { provider: PROVIDER, weatherModel: WEATHER_MODEL, validIntervals: result.intervals.length, retrievedAt, forecastIssuedAt: null } });
      return { ...result, generatedAt: retrievedAt };
    } catch (error) {
      failComponent(execution, error, { provider: PROVIDER });
      throw error;
    }
  }

  function getForecast(location, { refresh = false, workflowId = null } = {}) {
    const key = `weather:${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}:${location.elevation ?? 'auto'}`;
    return cache.getOrCreate(key, () => fetchForecast(location, workflowId), {
      refresh,
      now: now(),
      observe: cacheObserver(workflowId, 'WEATHER_FORECAST'),
    });
  }

  return { getForecast, cache };
}

module.exports = { PROVIDER, WEATHER_MODEL, BASE_URL, HOURLY_VARIABLES, utcTimestamp, normalizeResponse, createOpenMeteoService };

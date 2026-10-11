const test = require('node:test');
const assert = require('node:assert/strict');

const { farms } = require('../api_dashboard_data');
const { createGenerationService } = require('../services/generation_service');
const { createOpenMeteoService, HOURLY_VARIABLES } = require('../services/open_meteo_service');
const { solarGenerationMW, windGenerationMW } = require('../services/generation_engineering_service');
const { initialConfiguration, validateConfiguration, missingGenerationSimulationParameters } = require('../services/configuration_service');
const profile = require('../config/examples/phase2a_demo_profile');
const { getDatabase } = require('../services/database_service');

const NOW = Date.parse('2026-06-15T00:30:00Z');
const clone = value => structuredClone(value);

function activeDemoConfiguration() {
  const configuration = initialConfiguration();
  for (const [farmId, values] of Object.entries(profile.farms)) {
    configuration.generationSimulation.farms[farmId] = { ...configuration.generationSimulation.farms[farmId], ...clone(values) };
  }
  return { configVersion: 7, configuration };
}

function weatherRows({ count = 72, windSpeed = 8, missingField = null, start = NOW + 30 * 60000 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const row = {
      validAt: new Date(start + (index + 1) * 3600000).toISOString(),
      shortwave_radiation: 650, direct_radiation: 450, direct_normal_irradiance: 700, diffuse_radiation: 200,
      temperature_2m: 25, cloud_cover: 20, is_day: 1, wind_speed_80m: windSpeed,
      wind_speed_120m: windSpeed * 1.05, surface_pressure: 1013, wind_direction_80m: 230,
    };
    if (missingField && index === 10) row[missingField] = null;
    return row;
  });
}

function weatherResult(options = {}) {
  return {
    provider: 'OPEN_METEO', weatherModel: 'BEST_MATCH', requestedCoordinates: {}, returnedCoordinates: {},
    retrievedAt: new Date(NOW).toISOString(), forecastIssuedAt: null, units: { wind_speed_80m: 'm/s' }, intervals: weatherRows(options),
  };
}

function weatherService(result = weatherResult()) {
  return { getForecast: async () => result };
}

test('explicit demo profile is valid, complete, and retains simulation provenance', () => {
  const active = activeDemoConfiguration();
  assert.doesNotThrow(() => validateConfiguration(active.configuration));
  for (const farm of farms) assert.deepEqual(missingGenerationSimulationParameters(active.configuration, farm.farmId), []);
  assert.equal(active.configuration.generationSimulation.farms.sunpeak.latitude.sourceType, 'USER_CONFIGURED_SIMULATION');
  assert.equal(active.configuration.generationSimulation.farms.coastal.wind.cutInSpeedMps.sourceType, 'USER_CONFIGURED_SIMULATION');
});

test('weather-driven farm forecast returns exactly 72 continuous UTC intervals and five compatible horizons', async () => {
  const service = createGenerationService({ weatherService: weatherService(), now: () => NOW, configurationProvider: activeDemoConfiguration });
  const result = await service.getForecast(clone(farms[0]));
  assert.equal(result.status, 'READY');
  assert.equal(result.sourceType, 'WEATHER_DRIVEN_ENGINEERING_SIMULATION');
  assert.equal(result.intervals.length, 72);
  assert.deepEqual(result.horizons.map(item => item.horizon), ['1h', '6h', '24h', '48h', '72h']);
  assert.equal(result.horizons[4].validAt, result.intervals[71].intervalEnd);
  for (let index = 0; index < 72; index += 1) {
    assert.match(result.intervals[index].intervalStart, /Z$/);
    assert.equal(Date.parse(result.intervals[index].intervalEnd) - Date.parse(result.intervals[index].intervalStart), 3600000);
    if (index) assert.equal(result.intervals[index].intervalStart, result.intervals[index - 1].intervalEnd);
    assert.equal(result.intervals[index].configurationVersion, '7');
  }
});

test('solar engineering simulation enforces night zero and available AC capacity', () => {
  const config = {
    latitude: 0, longitude: 0, panelTiltDeg: 10, panelAzimuthDeg: 180, groundAlbedo: 0.2,
    nominalOperatingCellTemperatureC: 45, temperatureCoefficientPctPerC: -0.35, installedAcCapacityMW: 10,
    dcAcRatio: 1.2, systemLossPct: 10, inverterEfficiency: 0.98, availabilityPct: 80,
  };
  const weather = { shortwave_radiation: 1000, direct_normal_irradiance: 1000, diffuse_radiation: 200, temperature_2m: 25, is_day: 1 };
  assert.equal(solarGenerationMW({ ...weather, validAt: '2026-03-20T00:00:00Z' }, config), 0);
  assert.ok(solarGenerationMW({ ...weather, validAt: '2026-03-20T12:00:00Z' }, config) <= 8);
  assert.equal(solarGenerationMW({ ...weather, validAt: '2026-03-20T12:00:00Z', is_day: 0 }, config), 0);
});

test('wind engineering simulation enforces cut-in, cut-out, rated and available-capacity bounds', () => {
  const config = { hubHeightM: 80, cutInSpeedMps: 3, ratedSpeedMps: 12, cutOutSpeedMps: 25, windShearExponent: 0.14, referenceAirDensityKgM3: 1.225, turbineRatedPowerMW: 3, turbineCount: 4, installedAcCapacityMW: 10, availabilityPct: 90 };
  const weather = speed => ({ wind_speed_80m: speed, wind_speed_120m: speed, surface_pressure: 1013.25, temperature_2m: 15 });
  assert.equal(windGenerationMW(weather(2.9), config), 0);
  assert.equal(windGenerationMW(weather(25), config), 0);
  assert.ok(windGenerationMW(weather(12), config) <= 9);
  assert.ok(windGenerationMW(weather(18), config) <= 9);
});

test('generation is independent of battery state', async () => {
  const service = createGenerationService({ weatherService: weatherService(), now: () => NOW, configurationProvider: activeDemoConfiguration });
  const farm = clone(farms[2]);
  const first = await service.getForecast({ ...farm, batterySocPct: 10 }, { refresh: true });
  const second = await service.getForecast({ ...farm, batterySocPct: 95 }, { refresh: true });
  assert.deepEqual(first.intervals.map(item => item.predictedGenerationMW), second.intervals.map(item => item.predictedGenerationMW));
});

test('missing simulation configuration returns INCOMPLETE_SIMULATION_CONFIG without fabricated intervals', async () => {
  const service = createGenerationService({ weatherService: weatherService(), now: () => NOW, configurationProvider: () => ({ configVersion: 1, configuration: initialConfiguration() }) });
  const result = await service.getForecast(clone(farms[0]));
  assert.equal(result.status, 'INCOMPLETE_SIMULATION_CONFIG');
  assert.equal(result.intervals.length, 0);
  assert.ok(result.diagnostics.missing.includes('generationSimulation.farms.sunpeak.latitude'));
});

test('missing weather values and incomplete responses return DEGRADED without interpolation', async () => {
  const missingService = createGenerationService({ weatherService: weatherService(weatherResult({ missingField: 'shortwave_radiation' })), now: () => NOW, configurationProvider: activeDemoConfiguration });
  const missing = await missingService.getForecast(clone(farms[0]));
  assert.equal(missing.status, 'DEGRADED');
  assert.equal(missing.diagnostics.code, 'WEATHER_VARIABLE_MISSING');
  assert.equal(missing.intervals.length, 0);

  const incompleteService = createGenerationService({ weatherService: weatherService(weatherResult({ count: 71 })), now: () => NOW, configurationProvider: activeDemoConfiguration });
  const incomplete = await incompleteService.getForecast(clone(farms[0]));
  assert.equal(incomplete.status, 'DEGRADED');
  assert.equal(incomplete.diagnostics.code, 'INCOMPLETE_WEATHER_FORECAST');
});

test('weather provider failure returns UNAVAILABLE and does not use historical weather', async () => {
  const error = Object.assign(new Error('provider offline'), { code: 'WEATHER_PROVIDER_FAILED' });
  const service = createGenerationService({ weatherService: { getForecast: async () => { throw error; } }, now: () => NOW, configurationProvider: activeDemoConfiguration });
  const result = await service.getForecast(clone(farms[0]));
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.source, 'UNAVAILABLE');
  assert.equal(result.intervals.length, 0);
});

test('generation cache reuses output and preserves weather and configuration provenance', async () => {
  let calls = 0;
  const service = createGenerationService({
    weatherService: { getForecast: async () => { calls += 1; return weatherResult(); } },
    now: () => NOW, configurationProvider: activeDemoConfiguration,
  });
  const first = await service.getForecast(clone(farms[0]));
  const second = await service.getForecast(clone(farms[0]));
  assert.equal(calls, 1);
  assert.equal(second.agentRunId, first.agentRunId);
  assert.equal(second.weather.provider, 'OPEN_METEO');
  assert.equal(second.intervals[0].sourceType, 'WEATHER_DRIVEN_ENGINEERING_SIMULATION');
  assert.equal(second.configurationVersion, '7');
});

test('farm-specific configured coordinates are sent to the weather adapter', async () => {
  const locations = [];
  const service = createGenerationService({
    weatherService: { getForecast: async location => { locations.push(location); return weatherResult(); } },
    now: () => NOW, configurationProvider: activeDemoConfiguration,
  });
  await service.getForecast(clone(farms[0]));
  await service.getForecast(clone(farms[1]));
  assert.notDeepEqual(locations[0], locations[1]);
  assert.equal(locations[0].latitude, profile.farms.sunpeak.latitude.value);
  assert.equal(locations[1].latitude, profile.farms.desertbloom.latitude.value);
});

test('Open-Meteo adapter requests UTC SI data and reuses location cache', async () => {
  let calls = 0;
  let requestedUrl;
  const times = Array.from({ length: 96 }, (_, index) => new Date(Math.floor(NOW / 3600000) * 3600000 + index * 3600000).toISOString().slice(0, 16));
  const hourly = { time: times };
  for (const variable of HOURLY_VARIABLES) hourly[variable] = times.map(() => variable === 'is_day' ? 1 : 10);
  const fetcher = async url => {
    calls += 1;
    requestedUrl = url;
    return { ok: true, json: async () => ({ latitude: 27.2, longitude: 71, elevation: 225, timezone: 'GMT', utc_offset_seconds: 0, hourly_units: { wind_speed_80m: 'm/s' }, hourly }) };
  };
  const service = createOpenMeteoService({ fetcher, now: () => NOW });
  const location = { latitude: 27.2, longitude: 71, elevation: 225 };
  const first = await service.getForecast(location);
  const second = await service.getForecast(location);
  assert.equal(calls, 1);
  assert.equal(first.intervals.length, 72);
  const firstCompleteFutureIntervalEnd = Math.floor(NOW / 3600000) * 3600000 + 2 * 3600000;
  assert.equal(Date.parse(first.intervals[0].validAt), firstCompleteFutureIntervalEnd);
  assert.equal(second.retrievedAt, first.retrievedAt);
  assert.equal(requestedUrl.searchParams.get('timezone'), 'GMT');
  assert.equal(requestedUrl.searchParams.get('wind_speed_unit'), 'ms');
  assert.equal(first.forecastIssuedAt, null);
  const component = getDatabase().prepare("SELECT status, source_type, output_summary_json FROM component_executions WHERE component='WEATHER_FORECAST' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(component.status, 'COMPLETED');
  assert.equal(component.source_type, 'MODEL_PREDICTION');
  assert.equal(JSON.parse(component.output_summary_json).validIntervals, 72);
  const cacheEvents = getDatabase().prepare("SELECT event_type FROM workflow_events WHERE component='WEATHER_FORECAST' AND event_type LIKE 'CACHE_%'").all();
  assert.ok(cacheEvents.some(event => event.event_type === 'CACHE_MISS'));
  assert.ok(cacheEvents.some(event => event.event_type === 'CACHE_HIT'));
});

test('Open-Meteo alignment remains strictly future at an exact UTC hour boundary', () => {
  const exactHour = Math.floor(NOW / 3600000) * 3600000;
  const times = Array.from({ length: 96 }, (_, index) => new Date(exactHour + index * 3600000).toISOString().slice(0, 16));
  const hourly = { time: times };
  for (const variable of HOURLY_VARIABLES) hourly[variable] = times.map(() => variable === 'is_day' ? 1 : 10);
  const result = require('../services/open_meteo_service').normalizeResponse(
    { latitude: 27.2, longitude: 71, elevation: 225, timezone: 'GMT', utc_offset_seconds: 0, hourly },
    { latitude: 27.2, longitude: 71, elevation: 225, retrievedAt: new Date(exactHour).toISOString(), now: exactHour },
  );
  assert.equal(Date.parse(result.intervals[0].validAt), exactHour + 2 * 3600000);
  assert.ok(Date.parse(result.intervals[0].validAt) - 3600000 > exactHour);
});

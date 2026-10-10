const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createGenerationService, predictionInputsForFarm } = require('../services/generation_service');
const { createMarketService } = require('../services/market_service');
const { optimizeFarm } = require('../services/optimizer_service');
const { decide } = require('../services/decision_service');
const { createApiServer, fleetSummary } = require('../api_server');
const { farms, seriesFor, performanceFor } = require('../api_dashboard_data');
const { resetRuntimeStore } = require('../services/runtime_store');

const NOW = Date.parse('2026-10-09T12:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));

function farmFixture(overrides = {}) {
  return {
    ...clone(farms[0]),
    currentGenerationMW: 80,
    currentExportMW: 50,
    gridExportLimitMW: 100,
    connectionExportCapacityMW: 100,
    gridImportAllowed: true,
    gridImportLimitMW: 40,
    connectionImportCapacityMW: 40,
    currentImportMW: 0,
    maximumPurchaseMW: 30,
    batterySocPct: 50,
    reservePct: 20,
    batteryCapacityMWh: 100,
    batteryMaxPowerMW: 25,
    batterySafeChargePct: 95,
    availabilityPct: 100,
    outputLimitPct: 100,
    curtailmentMW: 0,
    ...overrides,
  };
}

function generationFixture({ one = 80, six = 70, confidence = 90 } = {}) {
  return {
    agent: 'GENERATION_FORECAST', agentRunId: 'generation-test', status: 'COMPLETED', source: 'MODEL',
    horizons: [
      { horizon: '1h', predictedGenerationMW: one, lowerBoundMW: one - 2, upperBoundMW: one + 2, confidencePct: confidence },
      { horizon: '6h', predictedGenerationMW: six, lowerBoundMW: six - 5, upperBoundMW: six + 5, confidencePct: confidence },
      { horizon: '24h', predictedGenerationMW: six, lowerBoundMW: six - 8, upperBoundMW: six + 8, confidencePct: confidence },
      { horizon: '48h', predictedGenerationMW: six, lowerBoundMW: six - 10, upperBoundMW: six + 10, confidencePct: confidence },
      { horizon: '72h', predictedGenerationMW: six, lowerBoundMW: six - 12, upperBoundMW: six + 12, confidencePct: confidence },
    ],
  };
}

function marketFixture({ current = 7000, one = 7200, six = 8000, confidence = 90, riskLevel = 'LOW' } = {}) {
  return {
    agent: 'MARKET', agentRunId: 'market-test', status: 'COMPLETED', source: 'MARKET_AGENT',
    currentPricePerMWh: current,
    forecasts: [
      { horizon: '1h', predictedPricePerMWh: one, confidencePct: confidence },
      { horizon: '6h', predictedPricePerMWh: six, confidencePct: confidence },
      { horizon: '24h', predictedPricePerMWh: six, confidencePct: confidence },
    ],
    trend: six > current ? 'RISING' : six < current ? 'FALLING' : 'STABLE',
    expectedPeakPricePerMWh: Math.max(current, one, six),
    expectedPeakAt: '2026-10-09T18:00:00Z',
    marketStatus: 'FAVORABLE', riskLevel, newsImpact: 'LOW', confidencePct: confidence, drivers: ['Test driver'],
  };
}

test.beforeEach(() => resetRuntimeStore());

test('generation forecast uses the existing model runner on success', async () => {
  const runner = async () => ({
    solar_power: 750, solar_power_lower: 700, solar_power_upper: 800, solar_power_confidence: 92,
    wind_power: 500, wind_power_lower: 450, wind_power_upper: 550, wind_power_confidence: 88,
  });
  const service = createGenerationService({ predictionRunner: runner, now: () => NOW });
  const result = await service.getForecast(farmFixture());
  assert.equal(result.source, 'MODEL_WITH_HISTORICAL_INPUTS');
  assert.equal(result.weatherInputSource, 'HISTORICAL_DATASET');
  assert.equal(result.horizons.length, 5);
  assert.equal(result.horizons[0].predictedGenerationMW, 90);
});

test('wind forecasts receive existing farm wind telemetry in model units', () => {
  const farm = clone(farms.find(item => item.type === 'WIND'));
  const inputs = predictionInputsForFarm(farm);
  assert.equal(inputs.wind_speed_80m, farm.weather.windSpeedMps * 3.6);
  assert.equal(inputs.wind_speed_120m, farm.weather.windSpeedMps * 3.6 * 1.06);
  assert.equal(inputs.wind_gusts_10m, farm.weather.windGustMps * 3.6);
  assert.equal(inputs.wind_direction_80m, farm.weather.windDirectionDeg);
  assert.equal(predictionInputsForFarm(farms.find(item => item.type === 'SOLAR')), undefined);
});

test('generation and market services reuse their 15-minute cache', async () => {
  let generationCalls = 0;
  let marketCalls = 0;
  const generation = createGenerationService({
    predictionRunner: async () => {
      generationCalls += 1;
      return { solar_power: 700, solar_power_lower: 650, solar_power_upper: 750, solar_power_confidence: 90 };
    },
    now: () => NOW,
  });
  const market = createMarketService({
    marketRunner: async () => {
      marketCalls += 1;
      return marketFixture();
    },
    now: () => NOW,
  });
  await generation.getForecast(farmFixture());
  await generation.getForecast(farmFixture());
  await Promise.all([market.getForecast(), market.getForecast()]);
  assert.equal(generationCalls, 5);
  assert.equal(marketCalls, 1);
});

test('generation forecast falls back to backend demo data', async () => {
  const service = createGenerationService({ predictionRunner: async () => { throw new Error('model down'); }, now: () => NOW });
  const result = await service.getForecast(farmFixture());
  assert.equal(result.source, 'MOCK_FALLBACK');
  assert.equal(result.horizons.length, 5);
});

test('market forecast accepts valid Market Agent output', async () => {
  const service = createMarketService({ marketRunner: async () => marketFixture(), now: () => NOW });
  const result = await service.getForecast();
  assert.equal(result.source, 'MARKET_AGENT');
  assert.equal(result.currentPricePerMWh, 7000);
});

test('market forecast falls back on malformed agent output', async () => {
  const service = createMarketService({ marketRunner: async () => ({ action: 'SELL' }), now: () => NOW });
  const result = await service.getForecast();
  assert.equal(result.source, 'MOCK_FALLBACK');
  assert.equal(result.agent, 'MARKET');
});

test('optimizer quantities obey reserve and grid limits', () => {
  const farm = farmFixture({ batterySocPct: 20, reservePct: 20, gridExportLimitMW: 55, gridImportLimitMW: 8, maximumPurchaseMW: 30 });
  const result = optimizeFarm({ farm, generationForecast: generationFixture({ one: 55, six: 50 }), marketForecast: marketFixture(), now: NOW });
  const sell = result.candidateStrategies.find(candidate => candidate.action === 'SELL');
  const buy = result.candidateStrategies.find(candidate => candidate.action === 'BUY');
  assert.ok(sell.quantityMW <= farm.gridExportLimitMW - farm.currentExportMW);
  assert.ok(buy.quantityMW <= farm.gridImportLimitMW - farm.currentImportMW);
  assert.equal(result.operationalAdjustments.availableBatteryDischargeMW, 0);
});

test('optimizer marks SELL infeasible when reserve protects all available energy', () => {
  const farm = farmFixture({ currentGenerationMW: 50, currentExportMW: 50, curtailmentMW: 0, batterySocPct: 20, reservePct: 20 });
  const result = optimizeFarm({ farm, generationForecast: generationFixture({ one: 50, six: 45 }), marketForecast: marketFixture(), now: NOW });
  const sell = result.candidateStrategies.find(candidate => candidate.action === 'SELL');
  assert.equal(sell.feasible, false);
  assert.equal(sell.quantityMW, 0);
});

function runDecision({ farm, generation, market }) {
  const optimizerResult = optimizeFarm({ farm, generationForecast: generation, marketForecast: market, now: NOW });
  return { optimizerResult, decision: decide({ farm, optimizerResult, generationForecast: generation, marketForecast: market, now: NOW }) };
}

test('Decision Agent selects BUY in a low-price, declining-generation scenario', () => {
  const result = runDecision({ farm: farmFixture({ batterySocPct: 30 }), generation: generationFixture({ one: 70, six: 40, confidence: 92 }), market: marketFixture({ current: 5000, one: 6500, six: 9000, confidence: 92 }) });
  assert.equal(result.decision.decision, 'BUY');
});

test('Decision Agent selects SELL in a high-current-price, strong-generation scenario', () => {
  const result = runDecision({ farm: farmFixture({ batterySocPct: 80 }), generation: generationFixture({ one: 95, six: 100, confidence: 92 }), market: marketFixture({ current: 10000, one: 8000, six: 6000, confidence: 92 }) });
  assert.equal(result.decision.decision, 'SELL');
});

test('Decision Agent selects HOLD for weak, low-confidence signals', () => {
  const result = runDecision({ farm: farmFixture(), generation: generationFixture({ one: 79, six: 81, confidence: 52 }), market: marketFixture({ current: 7000, one: 7040, six: 7100, confidence: 55 }) });
  assert.equal(result.decision.decision, 'HOLD');
});

test('Decision Agent cannot choose infeasible SELL or BUY candidates', () => {
  const noExport = runDecision({ farm: farmFixture({ gridExportLimitMW: 50 }), generation: generationFixture({ one: 100, six: 105 }), market: marketFixture({ current: 10000, six: 5000 }) });
  assert.notEqual(noExport.decision.decision, 'SELL');
  const noImport = runDecision({ farm: farmFixture({ gridImportAllowed: false, gridImportLimitMW: 0 }), generation: generationFixture({ one: 65, six: 40 }), market: marketFixture({ current: 4000, six: 9000 }) });
  assert.notEqual(noImport.decision.decision, 'BUY');
});

test('close BUY and SELL scores bias toward HOLD', () => {
  const farm = farmFixture({ batterySocPct: 40 });
  const generation = generationFixture({ one: 82, six: 80, confidence: 90 });
  const market = marketFixture({ current: 7000, one: 7050, six: 7100, confidence: 90 });
  const result = runDecision({ farm, generation, market });
  assert.equal(result.decision.decision, 'HOLD');
});

test('decision quantity exactly equals the selected Optimizer quantity', () => {
  const result = runDecision({ farm: farmFixture({ batterySocPct: 80 }), generation: generationFixture({ one: 100, six: 105 }), market: marketFixture({ current: 10000, six: 5000 }) });
  const selected = result.optimizerResult.candidateStrategies.find(candidate => candidate.action === result.decision.decision);
  assert.equal(result.decision.quantityMW, selected.quantityMW);
});

function dispatch(server, method, url, body) {
  return new Promise(resolve => {
    const request = new EventEmitter();
    request.method = method;
    request.url = url;
    request.headers = { host: 'localhost' };
    const response = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }); },
    };
    server.emit('request', request, response);
    queueMicrotask(() => {
      if (body) request.emit('data', JSON.stringify(body));
      request.emit('end');
    });
  });
}

test('unknown farm returns 404', async () => {
  const server = createApiServer();
  const response = await dispatch(server, 'GET', '/api/farms/not-a-farm');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'FARM_NOT_FOUND');
  server.close();
});

test('invalid operations update returns 400', async () => {
  const server = createApiServer();
  const response = await dispatch(server, 'PATCH', '/api/farms/sunpeak/operations', { reservePct: 140 });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_REQUEST');
  server.close();
});

test('generation history honors range and interval', () => {
  assert.equal(seriesFor(farmFixture(), { range: '12h', interval: '15m', now: NOW }).length, 49);
  assert.equal(seriesFor(farmFixture(), { range: '72h', interval: '1h', now: NOW }).length, 73);
  assert.throws(() => seriesFor(farmFixture(), { range: 'invalid' }), /range must be/);
});

test('fleet battery SOC is capacity weighted instead of hardcoded', () => {
  const expected = farms.reduce((sum, farm) => sum + farm.batteryCapacityMWh * farm.batterySocPct, 0)
    / farms.reduce((sum, farm) => sum + farm.batteryCapacityMWh, 0);
  assert.equal(fleetSummary(NOW).storage.socPct, Number(expected.toFixed(1)));
});

test('fleet current generation equals the sum of every farm reading', () => {
  const summary = fleetSummary(NOW);
  const expected = farms.reduce((sum, farm) => sum + farm.currentGenerationMW, 0);
  const breakdownTotal = summary.generationByFarm.reduce((sum, farm) => sum + farm.currentGenerationMW, 0);
  assert.equal(summary.liveGenerationMW, Number(expected.toFixed(1)));
  assert.equal(summary.liveGenerationMW, Number(breakdownTotal.toFixed(1)));
  assert.equal(summary.generationCalculation, 'SUM_OF_CURRENT_FARM_GENERATION_MW');
});

test('performance is internally consistent and marks unavailable accuracy', () => {
  const result = performanceFor(farms, 'today');
  assert.equal(Number((result.solarEnergyMWh + result.windEnergyMWh).toFixed(1)), result.energy);
  assert.equal(result.accuracy, null);
  assert.equal(result.source, 'SIMULATED');
});

test('decision action is idempotent and repeated execution returns 409', async () => {
  const generationService = { getForecast: async (farm) => ({ ...generationFixture({ one: farm.currentGenerationMW, six: farm.currentGenerationMW - 20 }), farmId: farm.farmId }) };
  const marketService = { getForecast: async () => marketFixture({ current: 5000, six: 9000 }) };
  const server = createApiServer({ generationService, marketService });
  const generated = await dispatch(server, 'GET', '/api/decision/recommendation?farmId=sunpeak');
  const first = await dispatch(server, 'POST', `/api/decision/recommendation/${generated.body.decisionId}/action`, { action: 'ACCEPT' });
  const repeated = await dispatch(server, 'POST', `/api/decision/recommendation/${generated.body.decisionId}/action`, { action: 'ACCEPT' });
  assert.equal(first.status, 200);
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.error.code, 'DECISION_ALREADY_APPLIED');
  server.close();
});

test('health reports market configuration required when no provider key exists', async () => {
  const previousDecisionKey = process.env.DECISION_AI_API_KEY;
  const previousMarketKey = process.env.MARKET_AI_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.DECISION_AI_API_KEY;
  delete process.env.MARKET_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const server = createApiServer();
  const response = await dispatch(server, 'GET', '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.components.marketAgent.status, 'CONFIGURATION_REQUIRED');
  assert.equal(response.body.components.optimizer.source, 'SIMULATED');
  server.close();
  if (previousDecisionKey) process.env.DECISION_AI_API_KEY = previousDecisionKey;
  if (previousMarketKey) process.env.MARKET_AI_API_KEY = previousMarketKey;
  if (previousOpenAiKey) process.env.OPENAI_API_KEY = previousOpenAiKey;
});

test('generation API labels simulated data and validates range', async () => {
  const server = createApiServer();
  const valid = await dispatch(server, 'GET', '/api/farms/sunpeak/generation?range=12h&interval=1h');
  const invalid = await dispatch(server, 'GET', '/api/farms/sunpeak/generation?range=10h&interval=1h');
  assert.equal(valid.body.source, 'SIMULATED');
  assert.equal(valid.body.data.length, 13);
  assert.equal(invalid.status, 400);
  server.close();
});

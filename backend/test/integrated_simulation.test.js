const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { farms } = require('../api_dashboard_data');
const { closeDatabase, getDatabase } = require('../services/database_service');
const { initializeAndRecoverFarmState } = require('../services/simulation_state_service');
const { initialConfiguration, createConfigurationVersion } = require('../services/configuration_service');
const profile = require('../config/examples/integrated_demo_profile');
const { createMarketSimulationService, generateDeterministicPrices } = require('../services/market_simulation_service');
const { optimizePortfolio } = require('../services/portfolio_optimizer_service');
const { createPortfolioDecision, validateDecisionReasoning } = require('../services/portfolio_decision_service');
const { persistPortfolioDecisionAction } = require('../services/audit_repository');
const { analyzeMarketOutlook } = require('../services/market_intelligence_service');
const { createApiServer } = require('../api_server');

let testDirectory;
let active;

function activateIntegratedConfiguration() {
  const configuration = initialConfiguration();
  configuration.sharedFleetLimits = structuredClone(profile.economics.sharedFleetLimits);
  configuration.battery.degradationCostPerMWh = structuredClone(profile.economics.battery.degradationCostPerMWh);
  configuration.economics = structuredClone(profile.economics.economics);
  configuration.optimization = structuredClone(profile.economics.optimization);
  configuration.aiLimits = structuredClone(profile.aiLimits);
  configuration.marketSimulation = structuredClone(profile.marketSimulation);
  return createConfigurationVersion(configuration, { createdBy: 'TEST', sourceType: 'USER_CONFIGURED_SIMULATION' });
}

function fixtures() {
  const start = Date.parse('2030-01-01T00:00:00.000Z');
  const planningIntervals = Array.from({ length: 72 }, (_, hour) => ({
    intervalStart: new Date(start + hour * 3600000).toISOString(),
    intervalEnd: new Date(start + (hour + 1) * 3600000).toISOString(),
  }));
  const generationOutlooks = farms.map((farm, farmIndex) => ({
    agentRunId: `generation-${farm.farmId}`, farmId: farm.farmId, status: 'READY', installedCapacityMW: farm.capacityMW,
    intervals: planningIntervals.map((interval, hour) => ({
      ...interval,
      predictedGenerationMW: farm.type === 'SOLAR'
        ? Math.max(0, Math.sin(((hour % 24) - 2) / 12 * Math.PI)) * farm.capacityMW * 0.8
        : farm.capacityMW * (0.48 + 0.12 * Math.sin((hour + farmIndex) / 5)),
    })),
  }));
  return { planningIntervals, generationOutlooks };
}

function dispatch(server, method, url, body) {
  return new Promise(resolve => {
    const request = new EventEmitter();
    request.method = method; request.url = url; request.headers = { host: 'localhost' }; request.socket = { remoteAddress: '127.0.0.1' };
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }); } };
    server.emit('request', request, response);
    queueMicrotask(() => { if (body) request.emit('data', JSON.stringify(body)); request.emit('end'); });
  });
}

test.beforeEach(() => {
  testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gridline-integrated-'));
  process.env.ENERGY_DB_PATH = path.join(testDirectory, 'integrated.sqlite');
  active = activateIntegratedConfiguration();
  initializeAndRecoverFarmState(farms);
});

test.afterEach(() => {
  closeDatabase();
  fs.rmSync(testDirectory, { recursive: true, force: true });
  process.env.ENERGY_DB_PATH = ':memory:';
});

test('deterministic market simulation produces reproducible 288-block and aligned 72-hour trajectories', () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const service = createMarketSimulationService();
  const first = service.getOutlook({ planningIntervals, generationOutlooks });
  const second = service.getOutlook({ planningIntervals, generationOutlooks });
  assert.equal(first.status, 'READY');
  assert.equal(first.nativeIntervals.length, 288);
  assert.equal(first.hourlyIntervals.length, 72);
  assert.deepEqual(first.nativeIntervals.map(item => item.priceINRPerMWh), second.nativeIntervals.map(item => item.priceINRPerMWh));
  assert.equal(first.hourlyIntervals[0].intervalStart, planningIntervals[0].intervalStart);
  assert.equal(first.hourlyIntervals.at(-1).intervalEnd, planningIntervals.at(-1).intervalEnd);
  assert.equal(new Set(first.nativeIntervals.map(item => item.sourceType)).size, 1);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM market_price_intervals').get().count, 288);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM market_observations').get().count, 0);
});

test('market simulator output changes only from declared scenario inputs', () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const normal = generateDeterministicPrices({ planningIntervals, generationOutlooks, scenario: profile.marketSimulation.scenarios.NORMAL_MARKET, scenarioId: 'NORMAL_MARKET', scenarioVersion: 1 });
  const high = generateDeterministicPrices({ planningIntervals, generationOutlooks, scenario: profile.marketSimulation.scenarios.HIGH_DEMAND, scenarioId: 'HIGH_DEMAND', scenarioVersion: 1 });
  assert.notDeepEqual(normal.map(item => item.pricePaisePerMWh), high.map(item => item.pricePaisePerMWh));
  assert.ok(normal.every((item, index) => index === 0 || Date.parse(item.intervalStart) - Date.parse(normal[index - 1].intervalStart) === 900000));
  const negativeScenario = { ...profile.marketSimulation.scenarios.NORMAL_MARKET, basePriceINRPerMWh: 100, events: [{ startHour: 0, durationHours: 1, priceAdderINRPerMWh: -500, label: 'Explicit negative-price test event' }] };
  const negative = generateDeterministicPrices({ planningIntervals, generationOutlooks, scenario: negativeScenario, scenarioId: 'NEGATIVE_TEST', scenarioVersion: 1 });
  assert.ok(negative.slice(0, 4).every(item => item.priceINRPerMWh < 0));
});

test('fleet MILP conserves energy and obeys charge, SOC, farm-grid, and shared-grid constraints', () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const plan = optimizePortfolio({ farms, generationOutlooks, marketOutlook, strategyName: 'BALANCED' });
  assert.equal(plan.status, 'OPTIMAL');
  assert.equal(plan.allocations.length, 288);
  assert.equal(plan.validation.valid, true);
  assert.ok(plan.allocations.every(row => !(row.energyStoredMWh > 1e-5 && row.batteryDischargeMWh > 1e-5)));
  for (let hour = 0; hour < 72; hour += 1) {
    const rows = plan.allocations.filter(row => row.hourIndex === hour);
    assert.ok(rows.reduce((sum, row) => sum + row.directExportMWh + row.batteryDischargeMWh, 0) <= active.configuration.sharedFleetLimits.gridExportCapacityMW.value + 1e-4);
    assert.ok(rows.reduce((sum, row) => sum + row.gridImportMWh, 0) <= active.configuration.sharedFleetLimits.gridImportCapacityMW.value + 1e-4);
  }
});

test('strategy presets are versioned and create meaningfully different objective results', () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const profit = optimizePortfolio({ farms, generationOutlooks, marketOutlook, strategyName: 'PROFIT_FOCUS' });
  const green = optimizePortfolio({ farms, generationOutlooks, marketOutlook, strategyName: 'GREEN_FOCUS' });
  assert.equal(profit.strategyVersion, 1);
  assert.equal(green.strategyVersion, 1);
  assert.ok(profit.totals.projectedNetValueINR >= green.totals.projectedNetValueINR - 1);
  assert.ok(green.totals.curtailedMWh <= profit.totals.curtailedMWh + 1e-4);
});

test('current output limits and battery operating modes constrain subsequent portfolio plans', () => {
  const constrainedFarms = structuredClone(farms);
  constrainedFarms[2].outputLimitPct = 50;
  constrainedFarms[2].batteryMode = 'IDLE';
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const plan = optimizePortfolio({ farms: constrainedFarms, generationOutlooks, marketOutlook, strategyName: 'BALANCED' });
  const coastal = plan.allocations.filter(row => row.farmId === 'coastal');
  assert.ok(coastal.every((row, hour) => Math.abs(row.expectedGenerationMWh - generationOutlooks[2].intervals[hour].predictedGenerationMW * 0.5) < 0.001));
  assert.ok(coastal.every(row => row.energyStoredMWh < 1e-5 && row.batteryDischargeMWh < 1e-5));
});

test('configured deterministic Decision fallback evaluates at most three plans and applies only hour one transactionally', async () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const decision = await createPortfolioDecision({ farms, generationOutlooks, marketOutlook });
  assert.equal(decision.status, 'DEGRADED');
  assert.equal(decision.strategyComparison.length, 3);
  assert.equal(decision.firstHourAllocations.length, 4);
  assert.equal(decision.plan.allocations.length, 288);
  assert.equal(decision.confidence.scorePct, 90);
  assert.equal(decision.confidence.label, 'STRONG');
  assert.equal(decision.confidence.calibratedProbability, false);
  assert.equal(decision.confidence.components.calibratedForecastUncertainty, 0);
  const result = persistPortfolioDecisionAction({ decision, action: 'ACCEPT', farms, configurationVersion: active.configVersion, configuration: active.configuration, now: Date.parse('2029-12-31T23:30:00.000Z') });
  assert.equal(result.status, 'APPLIED_SIMULATED');
  assert.equal(result.farms.length, 4);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM applied_portfolio_allocations WHERE decision_id=?').get(decision.decisionId).count, 4);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM simulated_financial_ledger WHERE decision_id=?').get(decision.decisionId).count, 4);
  const ledger = getDatabase().prepare('SELECT * FROM simulated_financial_ledger WHERE decision_id=? LIMIT 1').get(decision.decisionId);
  assert.equal(Number(ledger.net_value_inr.toFixed(4)), Number((ledger.gross_sale_revenue_inr - ledger.purchase_cost_inr - ledger.transaction_fees_inr - ledger.degradation_cost_inr - ledger.export_tariff_cost_inr - ledger.import_tariff_cost_inr).toFixed(4)));
  closeDatabase();
  initializeAndRecoverFarmState(farms);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM simulated_financial_ledger WHERE decision_id=?').get(decision.decisionId).count, 4);
  assert.equal(getDatabase().prepare("SELECT status FROM decision_proposals WHERE decision_id=?").get(decision.decisionId).status, 'APPLIED_SIMULATED');
  assert.throws(() => persistPortfolioDecisionAction({ decision, action: 'ACCEPT', farms, configurationVersion: active.configVersion, configuration: active.configuration }), error => error.code === 'DECISION_ALREADY_APPLIED');
});

test('portfolio optimization fails closed when economic assumptions are unavailable', () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const result = optimizePortfolio({ farms, generationOutlooks, marketOutlook, strategyName: 'BALANCED', configurationProvider: () => ({ configVersion: 999, configuration: initialConfiguration() }) });
  assert.equal(result.status, 'INCOMPLETE_ASSUMPTIONS');
  assert.ok(result.missing.includes('battery.degradationCostPerMWh'));
  assert.deepEqual(result.allocations, []);
});

test('approval rejects a recommendation after its configuration is superseded', async () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const decision = await createPortfolioDecision({ farms, generationOutlooks, marketOutlook });
  const superseding = createConfigurationVersion(structuredClone(active.configuration), { createdBy: 'TEST_SUPERSEDE', sourceType: 'USER_CONFIGURED_SIMULATION' });
  const result = persistPortfolioDecisionAction({ decision, action: 'ACCEPT', farms, configurationVersion: superseding.configVersion, configuration: superseding.configuration, now: Date.parse('2029-12-31T23:30:00.000Z') });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'STALE_CONFIGURATION');
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM applied_portfolio_allocations').get().count, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM simulated_financial_ledger').get().count, 0);
});

test('Market Intelligence failure does not invalidate the numerical trajectory', async () => {
  const { planningIntervals, generationOutlooks } = fixtures();
  const marketOutlook = createMarketSimulationService().getOutlook({ planningIntervals, generationOutlooks });
  const intelligence = await analyzeMarketOutlook(marketOutlook, { runner: async () => { throw new Error('provider unavailable'); } });
  assert.equal(intelligence.status, 'DEGRADED');
  assert.equal(intelligence.analysis, null);
  assert.equal(marketOutlook.status, 'READY');
  assert.equal(marketOutlook.nativeIntervals.length, 288);
});

test('Decision Agent structured output rejects incomplete or invented reasoning shapes', () => {
  assert.deepEqual(validateDecisionReasoning({ selectedOptimizerRunId: 'run-1', reasons: ['Best validated plan'], tradeoffs: ['Uses stored energy'], warnings: [] }).warnings, []);
  assert.throws(() => validateDecisionReasoning({ selectedOptimizerRunId: 'run-1', reasons: [], tradeoffs: ['Missing reason'], warnings: [] }), error => error.code === 'AI_INVALID_OUTPUT');
  assert.throws(() => validateDecisionReasoning({ selectedOptimizerRunId: 'run-1', reasons: ['Reason'], tradeoffs: 'not-an-array', warnings: [] }), error => error.code === 'AI_INVALID_OUTPUT');
});

test('portfolio decision API completes, approves, exposes audit history, and never applies the remaining 71 hours', async () => {
  const { generationOutlooks } = fixtures();
  const generationByFarm = new Map(generationOutlooks.map(outlook => [outlook.farmId, outlook]));
  const server = createApiServer({ generationService: { getForecast: async farm => generationByFarm.get(farm.farmId) } });
  const proposed = await dispatch(server, 'GET', '/api/decision/recommendation');
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.firstHourAllocations.length, 4);
  assert.equal(proposed.body.plan.allocations.length, 288);
  const approved = await dispatch(server, 'POST', `/api/decision/recommendation/${proposed.body.decisionId}/action`, { action: 'ACCEPT' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'APPLIED_SIMULATED');
  assert.equal(approved.body.farms.length, 4);
  const ledger = await dispatch(server, 'GET', '/api/financial-ledger');
  assert.equal(ledger.body.entries.length, 4);
  const decisions = await dispatch(server, 'GET', '/api/decisions');
  assert.equal(decisions.body.decisions[0].executionStatus, 'APPLIED_SIMULATED');
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM applied_portfolio_allocations').get().count, 4);
  server.close();
});

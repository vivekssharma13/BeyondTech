const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { farms, seriesFor, alertsFor, setAlertAcknowledged, performanceFor, RANGE_HOURS, INTERVAL_MINUTES } = require('./api_dashboard_data');
const { createGenerationService } = require('./services/generation_service');
const { createMarketService } = require('./services/market_service');
const { createMarketSimulationService } = require('./services/market_simulation_service');
const { analyzeMarketOutlook } = require('./services/market_intelligence_service');
const { optimizeFarm } = require('./services/optimizer_service');
const { optimizePortfolio, STRATEGIES } = require('./services/portfolio_optimizer_service');
const { decide } = require('./services/decision_service');
const { createPortfolioDecision } = require('./services/portfolio_decision_service');
const { operationsFor, updateOperations } = require('./services/operations_service');
const { listAgentRuns, recordActivity, listActivity, getDecision } = require('./services/runtime_store');
const { startWorkflow, completeWorkflow, failWorkflow, listWorkflows, getWorkflowDetails } = require('./services/workflow_service');
const { getActiveConfiguration, createConfigurationVersion, missingEconomicAssumptions, missingGenerationSimulationParameters, missingDecisionAgentAssumptions } = require('./services/configuration_service');
const { persistDecisionAction, persistPortfolioDecisionAction, listDecisionHistory, listSimulatedLedger } = require('./services/audit_repository');
const { getDatabase } = require('./services/database_service');
const { initializeAndRecoverFarmState } = require('./services/simulation_state_service');
const { marketDataReadiness } = require('./services/market_data_service');
const { REFERENCE_MARKET_DEFINITION } = require('./services/market_contract_service');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function apiError(response, status, code, message) {
  send(response, status, { error: { code, message, timestamp: new Date().toISOString() } });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new TypeError('Request body is too large'));
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new TypeError('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function findFarm(farmId) {
  return farms.find(farm => farm.farmId === farmId);
}

function ledgerRangeStart(range, now = Date.now()) {
  if (!range) return null;
  if (range === '7d') return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  if (range === '30d') return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (range === 'today' || range === 'ytd') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const month = range === 'ytd' ? 0 : parts.month - 1;
    const day = range === 'ytd' ? 1 : parts.day;
    return new Date(Date.UTC(parts.year, month, day) - 330 * 60 * 1000).toISOString();
  }
  throw new TypeError('ledger range must be one of today, 7d, 30d, ytd');
}

function ledgerRevenueByFarm(range = null, now = Date.now()) {
  const start = ledgerRangeStart(range, now);
  const rows = start
    ? getDatabase().prepare('SELECT farm_id, COALESCE(SUM(net_value_inr), 0) AS value FROM simulated_financial_ledger WHERE created_at >= ? GROUP BY farm_id').all(start)
    : getDatabase().prepare('SELECT farm_id, COALESCE(SUM(net_value_inr), 0) AS value FROM simulated_financial_ledger GROUP BY farm_id').all();
  return Object.fromEntries(rows.map(row => [row.farm_id, Number(row.value)]));
}

function farmsWithLedgerRevenue() {
  const revenue = ledgerRevenueByFarm('today');
  return farms.map(farm => ({ ...farm, revenueToday: Number(revenue[farm.farmId] || 0), revenueSource: 'PERSISTED_SIMULATED_FINANCIAL_LEDGER' }));
}

function fleetSummary(now = Date.now()) {
  const reportedFarms = farmsWithLedgerRevenue();
  const alerts = alertsFor(farms, new Date(now).toISOString());
  const totals = reportedFarms.reduce((sum, farm) => ({
    generation: sum.generation + farm.currentGenerationMW,
    forecast: sum.forecast + farm.forecastGenerationMW,
    capacity: sum.capacity + farm.capacityMW,
    availability: sum.availability + farm.availabilityPct,
    export: sum.export + farm.currentExportMW,
    limit: sum.limit + farm.gridExportLimitMW,
    import: sum.import + farm.currentImportMW,
    importLimit: sum.importLimit + farm.gridImportLimitMW,
    batteryCapacity: sum.batteryCapacity + farm.batteryCapacityMWh,
    batteryEnergy: sum.batteryEnergy + farm.batteryCapacityMWh * farm.batterySocPct / 100,
    batteryReserve: sum.batteryReserve + farm.batteryCapacityMWh * farm.reservePct / 100,
    revenue: sum.revenue + farm.revenueToday,
  }), { generation: 0, forecast: 0, capacity: 0, availability: 0, export: 0, limit: 0, import: 0, importLimit: 0, batteryCapacity: 0, batteryEnergy: 0, batteryReserve: 0, revenue: 0 });
  return {
    source: 'SIMULATED',
    generatedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    liveGenerationMW: Number(totals.generation.toFixed(1)),
    generationCalculation: 'SUM_OF_CURRENT_FARM_GENERATION_MW',
    generationByFarm: reportedFarms.map(farm => ({
      farmId: farm.farmId,
      name: farm.name,
      currentGenerationMW: farm.currentGenerationMW,
      source: 'SIMULATED',
    })),
    forecastGenerationMW: Number(totals.forecast.toFixed(1)),
    installedCapacityMW: totals.capacity,
    fleetUtilizationPct: Number((totals.generation / totals.capacity * 100).toFixed(1)),
    fleetAvailabilityPct: Number((totals.availability / farms.length).toFixed(1)),
    grid: {
      currentExportMW: Number(totals.export.toFixed(1)),
      exportLimitMW: totals.limit,
      headroomMW: Number((totals.limit - totals.export).toFixed(1)),
      currentImportMW: Number(totals.import.toFixed(1)),
      importLimitMW: totals.importLimit,
    },
    storage: {
      totalCapacityMWh: totals.batteryCapacity,
      socPct: Number((totals.batteryEnergy / totals.batteryCapacity * 100).toFixed(1)),
      reservePct: Number((totals.batteryReserve / totals.batteryCapacity * 100).toFixed(1)),
    },
    revenueToday: totals.revenue,
    activeAlerts: alerts.filter(alert => !alert.acknowledged).length,
  };
}

function legacyModelReadiness() {
  const python = fs.existsSync(path.join(ROOT, '..', '.venv', 'bin', 'python'))
    ? path.join(ROOT, '..', '.venv', 'bin', 'python') : 'python3';
  const modelDir = path.join(ROOT, '..', 'model');
  const artifactsReady = ['best_solar_power_model.joblib', 'best_wind_power_model.joblib'].every(file => fs.existsSync(path.join(modelDir, file)));
  const pythonReady = spawnSync(python, ['--version'], { timeout: 2000 }).status === 0;
  return { status: artifactsReady && pythonReady ? 'READY' : 'UNAVAILABLE', artifactsReady, pythonReady };
}

function configuredMarketKey() {
  if (process.env.DECISION_AI_API_KEY || process.env.MARKET_AI_API_KEY || process.env.OPENAI_API_KEY) return true;
  const envPaths = [path.join(ROOT, '..', '.env'), path.join(ROOT, '..', 'market_model', '.env')];
  return envPaths.some(envPath => fs.existsSync(envPath) && /^(DECISION_AI_API_KEY|MARKET_AI_API_KEY|OPENAI_API_KEY)=.+$/m.test(fs.readFileSync(envPath, 'utf8')));
}

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress || request.connection?.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function configurationWritesAllowed(request) {
  return process.env.NODE_ENV === 'development'
    && process.env.ENABLE_LOCAL_CONFIGURATION_WRITES === 'true'
    && isLoopbackRequest(request);
}

function createApiServer(options = {}) {
  getDatabase();
  getActiveConfiguration();
  initializeAndRecoverFarmState(farms);
  const generationService = options.generationService || createGenerationService();
  const marketService = options.marketService || createMarketService();
  const numericalMarketService = options.numericalMarketService || createMarketSimulationService();

  async function runWorkflow(definition, operation) {
    const workflow = startWorkflow(definition);
    try {
      const result = await operation(workflow.workflowId);
      completeWorkflow(workflow, { source: result?.source, status: result?.status, farmId: result?.farmId });
      return { result, workflowId: workflow.workflowId };
    } catch (error) {
      failWorkflow(workflow, error);
      throw error;
    }
  }

  async function pipelineFor(farm, { refresh = false, workflowId = null } = {}) {
    const [generationForecast, marketForecast] = await Promise.all([
      generationService.getForecast(farm, { refresh, workflowId }),
      marketService.getForecast({ refresh, workflowId }),
    ]);
    const optimizerResult = optimizeFarm({ farm, generationForecast, marketForecast, workflowId });
    return { generationForecast, marketForecast, optimizerResult };
  }

  async function decisionFor(farm, optionsForRun = {}) {
    const pipeline = await pipelineFor(farm, optionsForRun);
    return decide({ farm, ...pipeline, workflowId: optionsForRun.workflowId || null });
  }

  async function portfolioInputs({ refresh = false, workflowId = null, includeIntelligence = false } = {}) {
    const generationOutlooks = await Promise.all(farms.map(farm => generationService.getForecast(farm, { refresh, workflowId })));
    const unavailable = generationOutlooks.filter(item => item.status !== 'READY');
    if (unavailable.length) return { status: 'INCOMPLETE_GENERATION_OUTLOOK', generationOutlooks, marketOutlook: null, intelligence: null };
    const planningIntervals = generationOutlooks[0].intervals.map(item => ({ intervalStart: item.intervalStart, intervalEnd: item.intervalEnd }));
    for (const outlook of generationOutlooks.slice(1)) {
      if (outlook.intervals.some((item, index) => item.intervalStart !== planningIntervals[index].intervalStart || item.intervalEnd !== planningIntervals[index].intervalEnd)) {
        throw Object.assign(new Error('Farm generation forecasts do not share identical planning intervals'), { code: 'FORECAST_ALIGNMENT_ERROR' });
      }
    }
    const enriched = generationOutlooks.map((outlook, index) => ({ ...outlook, installedCapacityMW: farms[index].capacityMW }));
    const marketOutlook = numericalMarketService.getOutlook({ planningIntervals, generationOutlooks: enriched, workflowId });
    const intelligence = includeIntelligence && marketOutlook.status === 'READY' ? await analyzeMarketOutlook(marketOutlook, { workflowId }) : null;
    return { status: marketOutlook.status === 'READY' ? 'READY' : marketOutlook.status, generationOutlooks: enriched, marketOutlook: intelligence ? { ...marketOutlook, intelligence } : marketOutlook, intelligence };
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const refresh = url.searchParams.get('refresh') === 'true';

    try {
      if (request.method === 'OPTIONS') {
        send(response, 204, '');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const marketConfigured = configuredMarketKey();
        const runtimeRuns = listAgentRuns();
        const latestSuccessful = agent => runtimeRuns.find(run => run.agent === agent && ['COMPLETED', 'READY'].includes(run.status))?.generatedAt || null;
        const python = fs.existsSync(path.join(ROOT, '..', '.venv', 'bin', 'python')) ? path.join(ROOT, '..', '.venv', 'bin', 'python') : 'python3';
        const marketPackageReady = spawnSync(python, ['-c', 'import openai'], { timeout: 2000 }).status === 0;
        const activeConfiguration = getActiveConfiguration();
        const missingGenerationConfiguration = farms.flatMap(farm => missingGenerationSimulationParameters(activeConfiguration.configuration, farm.farmId));
        const legacyPrediction = legacyModelReadiness();
        const generation = {
          status: missingGenerationConfiguration.length ? 'INCOMPLETE_SIMULATION_CONFIG' : 'READY',
          mode: 'WEATHER_DRIVEN_ENGINEERING_SIMULATION',
          weatherProvider: 'OPEN_METEO',
          modelVersion: 'weather-engineering-v1',
          configurationVersion: activeConfiguration.configVersion,
          missingConfiguration: missingGenerationConfiguration,
          forecastAccuracy: null,
          legacyPredictionEndpoint: { ...legacyPrediction, operationalForecastSource: false },
        };
        const schemaVersion = Number(getDatabase().prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0);
        send(response, 200, {
          ok: generation.status === 'READY',
          checkedAt: new Date().toISOString(),
          components: {
            generationModel: { ...generation, lastSuccessfulRunAt: latestSuccessful('GENERATION_FORECAST') },
            marketAgent: { status: !marketConfigured ? 'CONFIGURATION_REQUIRED' : marketPackageReady ? 'READY' : 'UNAVAILABLE', providerConfigured: marketConfigured, pythonPackageReady: marketPackageReady, fallbackAvailable: true, lastSuccessfulRunAt: latestSuccessful('MARKET') },
            optimizer: { status: missingEconomicAssumptions(activeConfiguration.configuration).length ? 'INCOMPLETE_ASSUMPTIONS' : 'READY', source: 'PORTFOLIO_MILP', solver: 'javascript-lp-solver', lastSuccessfulRunAt: latestSuccessful('FLEET_OPTIMIZER') },
            decisionAgent: { status: missingDecisionAgentAssumptions(activeConfiguration.configuration).length ? 'INCOMPLETE_ASSUMPTIONS' : marketConfigured ? 'READY' : activeConfiguration.configuration.aiLimits.allowDeterministicFallback.value ? 'DEGRADED_FALLBACK_AVAILABLE' : 'CONFIGURATION_REQUIRED', source: marketConfigured ? 'OPENAI' : 'UNAVAILABLE', mode: 'BOUNDED_TOOL_CALLING', lastSuccessfulRunAt: latestSuccessful('OPENAI_DECISION_AGENT') },
            persistence: { status: 'READY', engine: 'SQLITE', schemaVersion },
            configuration: { status: missingEconomicAssumptions(activeConfiguration.configuration).length ? 'INCOMPLETE_ASSUMPTIONS' : 'READY', configVersion: activeConfiguration.configVersion },
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/fleet') {
        send(response, 200, fleetSummary());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/farms') {
        send(response, 200, { farms: farmsWithLedgerRevenue(), source: 'SIMULATED', generatedAt: new Date().toISOString() });
        return;
      }

      const operationsMatch = url.pathname.match(/^\/api\/farms\/([^/]+)\/operations$/);
      if (operationsMatch && ['GET', 'PATCH'].includes(request.method)) {
        const farm = findFarm(operationsMatch[1]);
        if (!farm) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${operationsMatch[1]} does not exist.`);
          return;
        }
        if (request.method === 'GET') send(response, 200, operationsFor(farm));
        else send(response, 200, updateOperations(farm, await readJson(request)));
        return;
      }

      const generationMatch = url.pathname.match(/^\/api\/farms\/([^/]+)\/generation$/);
      if (request.method === 'GET' && generationMatch) {
        const farm = findFarm(generationMatch[1]);
        if (!farm) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${generationMatch[1]} does not exist.`);
          return;
        }
        const range = url.searchParams.get('range') || '24h';
        const interval = url.searchParams.get('interval') || '15m';
        if (!RANGE_HOURS[range] || !INTERVAL_MINUTES[interval]) {
          apiError(response, 400, 'INVALID_TIME_RANGE', `range must be ${Object.keys(RANGE_HOURS).join('/')} and interval must be ${Object.keys(INTERVAL_MINUTES).join('/')}.`);
          return;
        }
        const generatedAt = new Date().toISOString();
        send(response, 200, { farmId: farm.farmId, source: 'SIMULATED', generatedAt, updatedAt: generatedAt, range, interval, data: seriesFor(farm, { range, interval }) });
        return;
      }

      const forecastMatch = url.pathname.match(/^\/api\/farms\/([^/]+)\/forecast$/);
      if (request.method === 'GET' && forecastMatch) {
        const farm = findFarm(forecastMatch[1]);
        if (!farm) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${forecastMatch[1]} does not exist.`);
          return;
        }
        const execution = await runWorkflow({ workflowType: 'GENERATION_FORECAST_REQUEST', farmId: farm.farmId, metadata: { refresh } }, workflowId => generationService.getForecast(farm, { refresh, workflowId }));
        send(response, 200, { ...execution.result, workflowId: execution.workflowId });
        return;
      }

      const farmMatch = url.pathname.match(/^\/api\/farms\/([^/]+)$/);
      if (request.method === 'GET' && farmMatch) {
        const farm = findFarm(farmMatch[1]);
        if (!farm) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmMatch[1]} does not exist.`);
          return;
        }
        const revenue = ledgerRevenueByFarm('today');
        send(response, 200, { ...farm, revenueToday: Number(revenue[farm.farmId] || 0), revenueSource: 'PERSISTED_SIMULATED_FINANCIAL_LEDGER', source: 'SIMULATED', generatedAt: new Date().toISOString() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/market/forecast') {
        const execution = await runWorkflow({ workflowType: 'MARKET_OUTLOOK_REQUEST', metadata: { refresh } }, workflowId => portfolioInputs({ refresh, workflowId, includeIntelligence: true }).then(result => result.marketOutlook || { status: result.status, source: 'UNAVAILABLE' }));
        send(response, 200, { ...execution.result, workflowId: execution.workflowId });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/market/contract') {
        const active = getActiveConfiguration();
        const activeScenarioId = active.configuration.marketSimulation?.activeScenarioId?.value || null;
        send(response, 200, { ...REFERENCE_MARKET_DEFINITION, activationStatus: activeScenarioId ? 'ACTIVE_DEMO_SIMULATION' : 'INACTIVE', activeScenarioId, configurationVersion: active.configVersion, readiness: marketDataReadiness() });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/market/data-readiness') {
        send(response, 200, marketDataReadiness());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/market/historical-forecast-readiness') {
        const readiness = marketDataReadiness();
        send(response, 200, { mode: 'HISTORICAL_DATA', status: 'INCOMPLETE_DATA', numericalForecastingEnabled: false, datasetReadiness: readiness, reason: readiness.datasets.length ? 'No leakage-free numerical model has been trained and approved for the imported dataset.' : 'No permitted historical market dataset has been imported.', metrics: null, modelArtifact: null });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/optimizer/recommendations') {
        const farmId = url.searchParams.get('farmId');
        if (!farmId) {
          const strategyName = url.searchParams.get('strategy') || 'BALANCED';
          if (!STRATEGIES.has(strategyName)) {
            apiError(response, 400, 'INVALID_STRATEGY', `strategy must be one of ${[...STRATEGIES].join(', ')}`);
            return;
          }
          const execution = await runWorkflow({ workflowType: 'PORTFOLIO_OPTIMIZATION', metadata: { refresh, strategyName } }, async workflowId => {
            const inputs = await portfolioInputs({ refresh, workflowId });
            if (inputs.status !== 'READY') return { agent: 'FLEET_OPTIMIZER', status: inputs.status, allocations: [], marketOutlook: inputs.marketOutlook };
            return optimizePortfolio({ farms, generationOutlooks: inputs.generationOutlooks, marketOutlook: inputs.marketOutlook, strategyName, workflowId });
          });
          send(response, 200, { ...execution.result, workflowId: execution.workflowId });
          return;
        }
        const selected = farmId ? [findFarm(farmId)].filter(Boolean) : farms;
        if (farmId && selected.length === 0) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmId} does not exist.`);
          return;
        }
        const execution = await runWorkflow({ workflowType: 'OPTIMIZER_REQUEST', farmId: farmId || null, metadata: { refresh, farmCount: selected.length } }, workflowId => Promise.all(selected.map(farm => pipelineFor(farm, { refresh, workflowId }).then(result => result.optimizerResult))).then(results => ({ results, status: results.some(result => result.status === 'DEGRADED') ? 'DEGRADED' : 'COMPLETED' })));
        const results = execution.result.results;
        if (farmId) send(response, 200, { ...results[0], workflowId: execution.workflowId });
        else {
          const candidates = results.flatMap(result => result.candidateStrategies.map(candidate => ({ farmId: result.farmId, ...candidate })));
          send(response, 200, { agent: 'OPTIMIZER', status: execution.result.status, workflowId: execution.workflowId, generatedAt: new Date().toISOString(), results, candidateStrategies: candidates, recommendations: candidates });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/decision/recommendation') {
        const farmId = url.searchParams.get('farmId');
        if (!farmId) {
          const execution = await runWorkflow({ workflowType: 'PORTFOLIO_DECISION', metadata: { refresh, maximumScenarios: 3 } }, async workflowId => {
            const inputs = await portfolioInputs({ refresh, workflowId });
            if (inputs.status !== 'READY') return { agent: 'OPENAI_DECISION_AGENT', status: inputs.status, executionStatus: 'NOT_CREATED' };
            return createPortfolioDecision({ farms, generationOutlooks: inputs.generationOutlooks, marketOutlook: inputs.marketOutlook, workflowId });
          });
          send(response, 200, { ...execution.result, workflowId: execution.workflowId });
          return;
        }
        const selected = farmId ? [findFarm(farmId)].filter(Boolean) : farms;
        if (farmId && selected.length === 0) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmId} does not exist.`);
          return;
        }
        const execution = await runWorkflow({ workflowType: 'DECISION_RECOMMENDATION', farmId: farmId || null, metadata: { refresh, farmCount: selected.length } }, workflowId => Promise.all(selected.map(farm => decisionFor(farm, { refresh, workflowId }))).then(decisions => ({ decisions, status: decisions.some(decision => decision.status === 'DEGRADED') ? 'DEGRADED' : 'COMPLETED' })));
        const decisions = execution.result.decisions;
        send(response, 200, farmId ? { ...decisions[0], workflowId: execution.workflowId } : { agent: 'DECISION', status: execution.result.status, workflowId: execution.workflowId, generatedAt: new Date().toISOString(), decisions });
        return;
      }

      const decisionActionMatch = url.pathname.match(/^\/api\/decision\/recommendation\/([^/]+)\/action$/);
      if (request.method === 'POST' && decisionActionMatch) {
        const recommendation = getDecision(decisionActionMatch[1]);
        if (!recommendation) {
          apiError(response, 404, 'DECISION_NOT_FOUND', `Decision ${decisionActionMatch[1]} does not exist.`);
          return;
        }
        const body = await readJson(request);
        if (!['ACCEPT', 'DISMISS'].includes(body.action)) {
          apiError(response, 400, 'INVALID_DECISION_ACTION', 'action must be ACCEPT or DISMISS.');
          return;
        }
        if (recommendation.executionStatus !== 'PENDING') {
          apiError(response, 409, 'DECISION_ALREADY_APPLIED', `Decision ${recommendation.decisionId} is already ${recommendation.executionStatus}.`);
          return;
        }
        const executionConfiguration = getActiveConfiguration().configuration;
        if (Array.isArray(recommendation.firstHourAllocations)) {
          const active = getActiveConfiguration();
          const persisted = persistPortfolioDecisionAction({ decision: recommendation, action: body.action, farms, configurationVersion: active.configVersion, configuration: active.configuration });
          for (const applied of persisted.farms) Object.assign(findFarm(applied.farmId), applied.after);
          recommendation.executionStatus = persisted.status;
          recommendation.executedAt = persisted.appliedAt;
          recordActivity({ type: body.action === 'ACCEPT' ? 'PORTFOLIO_DECISION_APPLIED' : 'PORTFOLIO_DECISION_DISMISSED', message: body.action === 'ACCEPT' ? `Applied the first portfolio-plan hour across ${persisted.farms.length} farms.` : 'Portfolio recommendation dismissed.' });
          send(response, 200, { simulation: true, sourceType: 'USER_CONFIGURED_SIMULATION', ...persisted });
          return;
        }
        const farm = findFarm(recommendation.farmId);
        const chargingEfficiency = executionConfiguration.battery.chargingEfficiency.value;
        const dischargingEfficiency = executionConfiguration.battery.dischargingEfficiency.value;
        const persisted = persistDecisionAction({ decision: recommendation, action: body.action, farm, chargingEfficiency, dischargingEfficiency });
        Object.assign(farm, persisted.after);
        recommendation.executionStatus = persisted.status;
        recommendation.executedAt = persisted.createdAt;
        recordActivity({
          type: body.action === 'ACCEPT' ? 'DECISION_ACCEPTED' : 'DECISION_DISMISSED',
          farmId: recommendation.farmId,
          message: `${recommendation.decision} ${recommendation.quantityMW} MW decision ${body.action.toLowerCase()}ed in simulation.`,
        });
        send(response, 200, { simulation: true, source: 'SIMULATED', sourceType: 'USER_CONFIGURED_SIMULATION', status: recommendation.executionStatus, decisionId: recommendation.decisionId, before: persisted.before, after: persisted.after, stateVersion: persisted.stateVersion });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/workflows') {
        send(response, 200, { workflows: listWorkflows({ limit: url.searchParams.get('limit') }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/decisions') {
        send(response, 200, { decisions: listDecisionHistory({ limit: url.searchParams.get('limit') }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/financial-ledger') {
        send(response, 200, { entries: listSimulatedLedger({ limit: url.searchParams.get('limit') }), sourceType: 'USER_CONFIGURED_SIMULATION' });
        return;
      }
      const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
      if (request.method === 'GET' && workflowMatch) {
        const details = getWorkflowDetails(workflowMatch[1]);
        if (!details) apiError(response, 404, 'WORKFLOW_NOT_FOUND', `Workflow ${workflowMatch[1]} does not exist.`);
        else send(response, 200, details);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/configuration') {
        const active = getActiveConfiguration();
        send(response, 200, { ...active, economicReadiness: missingEconomicAssumptions(active.configuration).length ? 'INCOMPLETE_ASSUMPTIONS' : 'READY', missingEconomicAssumptions: missingEconomicAssumptions(active.configuration), decisionAgentReadiness: missingDecisionAgentAssumptions(active.configuration).length ? 'INCOMPLETE_ASSUMPTIONS' : 'READY', missingDecisionAgentAssumptions: missingDecisionAgentAssumptions(active.configuration), marketSimulationStatus: active.configuration.marketSimulation?.activeScenarioId?.value ? 'ACTIVE_DEMO_SIMULATION' : 'INCOMPLETE_SIMULATION_CONFIG' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/configuration') {
        if (!configurationWritesAllowed(request)) {
          apiError(response, 403, 'CONFIGURATION_WRITE_DISABLED', 'Configuration writes require an explicitly enabled local development environment.');
          return;
        }
        const body = await readJson(request);
        send(response, 201, createConfigurationVersion(body.configuration, { createdBy: body.createdBy || 'API_OPERATOR', sourceType: 'USER_CONFIGURED_SIMULATION' }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/alerts') {
        const generatedAt = new Date().toISOString();
        send(response, 200, { alerts: alertsFor(farms, generatedAt), source: 'SIMULATED', generatedAt });
        return;
      }
      const alertMatch = url.pathname.match(/^\/api\/alerts\/([^/]+)$/);
      if (request.method === 'PATCH' && alertMatch) {
        const alert = alertsFor(farms).find(item => String(item.id) === alertMatch[1]);
        if (!alert) {
          apiError(response, 404, 'ALERT_NOT_FOUND', `Alert ${alertMatch[1]} does not exist.`);
          return;
        }
        const body = await readJson(request);
        if (typeof body.acknowledged !== 'boolean') {
          apiError(response, 400, 'INVALID_ALERT_UPDATE', 'acknowledged must be a boolean.');
          return;
        }
        setAlertAcknowledged(alert.id, body.acknowledged);
        alert.acknowledged = body.acknowledged;
        recordActivity({ type: 'ALERT_UPDATED', message: `Alert ${alert.id} was ${alert.acknowledged ? 'acknowledged' : 'reopened'}.` });
        send(response, 200, alert);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/agent-runs') {
        const agent = url.searchParams.get('agent') || undefined;
        const farmId = url.searchParams.get('farmId') || undefined;
        send(response, 200, { agent: agent || 'ALL', runs: listAgentRuns({ agent, farmId }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/activity') {
        send(response, 200, { activity: listActivity({ farmId: url.searchParams.get('farmId') || undefined }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/performance') {
        const farmId = url.searchParams.get('farmId') || undefined;
        if (farmId && !findFarm(farmId)) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmId} does not exist.`);
          return;
        }
        const range = url.searchParams.get('range') || 'today';
        send(response, 200, performanceFor(farms, range, farmId, ledgerRevenueByFarm(range)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/freshness') {
        const runs = listAgentRuns();
        const latest = agent => runs.find(run => run.agent === agent)?.generatedAt || null;
        send(response, 200, {
          source: 'SIMULATED',
          checkedAt: new Date().toISOString(),
          telemetry: { updatedAt: new Date().toISOString(), source: 'SIMULATED' },
          weather: { updatedAt: latest('GENERATION_FORECAST'), source: runs.find(run => run.agent === 'GENERATION_FORECAST' && run.status === 'READY') ? 'OPEN_METEO' : null },
          grid: { updatedAt: new Date().toISOString(), source: 'SIMULATED' },
          generationForecast: { updatedAt: latest('GENERATION_FORECAST'), cacheExpiresAt: runs.find(run => run.agent === 'GENERATION_FORECAST')?.nextRunAt || null, scheduled: false, nextScheduledRunAt: null, nextRunAt: runs.find(run => run.agent === 'GENERATION_FORECAST')?.nextRunAt || null, source: runs.find(run => run.agent === 'GENERATION_FORECAST')?.source || null },
          marketForecast: { updatedAt: latest('MARKET'), cacheExpiresAt: runs.find(run => run.agent === 'MARKET')?.nextRunAt || null, scheduled: false, nextScheduledRunAt: null, nextRunAt: runs.find(run => run.agent === 'MARKET')?.nextRunAt || null, source: runs.find(run => run.agent === 'MARKET')?.source || null },
          optimizer: { updatedAt: latest('OPTIMIZER'), source: 'SIMULATED' },
          decision: { updatedAt: latest('DECISION'), source: 'SIMULATED' },
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/predict') {
        const body = await readJson(request);
        if (!body.date) {
          apiError(response, 400, 'INVALID_PREDICTION_INPUT', 'date is required.');
          return;
        }
        try {
          send(response, 200, await generationService.runPrediction(body));
        } catch (error) {
          apiError(response, 500, 'PREDICTION_FAILED', error.message);
        }
        return;
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        send(response, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html');
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        send(response, 200, fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), 'application/javascript');
        return;
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      if (error.code === 'DECISION_ALREADY_APPLIED') {
        apiError(response, 409, 'DECISION_ALREADY_APPLIED', error.message);
        return;
      }
      const isBadRequest = error instanceof TypeError;
      apiError(response, isBadRequest ? 400 : 500, isBadRequest ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', error.message);
    }
  });
}

if (require.main === module) {
  createApiServer().listen(PORT, () => console.log(`Solar/wind API and UI: http://localhost:${PORT}`));
}

module.exports = { createApiServer, fleetSummary, findFarm, configurationWritesAllowed, ledgerRangeStart };

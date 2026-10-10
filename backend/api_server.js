const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { farms, seriesFor, alertsFor, setAlertAcknowledged, performanceFor, RANGE_HOURS, INTERVAL_MINUTES } = require('./api_dashboard_data');
const { createGenerationService } = require('./services/generation_service');
const { createMarketService } = require('./services/market_service');
const { optimizeFarm } = require('./services/optimizer_service');
const { decide } = require('./services/decision_service');
const { operationsFor, updateOperations } = require('./services/operations_service');
const { listAgentRuns, recordActivity, listActivity, getDecision } = require('./services/runtime_store');

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

function fleetSummary(now = Date.now()) {
  const alerts = alertsFor(farms, new Date(now).toISOString());
  const totals = farms.reduce((sum, farm) => ({
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

function modelReadiness() {
  const python = fs.existsSync(path.join(ROOT, '..', '.venv', 'bin', 'python'))
    ? path.join(ROOT, '..', '.venv', 'bin', 'python') : 'python3';
  const modelDir = path.join(ROOT, '..', 'model');
  const artifactsReady = ['best_solar_power_model.joblib', 'best_wind_power_model.joblib'].every(file => fs.existsSync(path.join(modelDir, file)));
  const pythonReady = spawnSync(python, ['--version'], { timeout: 2000 }).status === 0;
  return { status: artifactsReady && pythonReady ? 'READY' : 'UNAVAILABLE', artifactsReady, pythonReady };
}

function configuredMarketKey() {
  if (process.env.DECISION_AI_API_KEY || process.env.MARKET_AI_API_KEY || process.env.OPENAI_API_KEY) return true;
  const envPath = path.join(ROOT, '..', '.env');
  if (!fs.existsSync(envPath)) return false;
  return /^(DECISION_AI_API_KEY|MARKET_AI_API_KEY|OPENAI_API_KEY)=.+$/m.test(fs.readFileSync(envPath, 'utf8'));
}

function createApiServer(options = {}) {
  const generationService = options.generationService || createGenerationService();
  const marketService = options.marketService || createMarketService();

  async function pipelineFor(farm, { refresh = false } = {}) {
    const [generationForecast, marketForecast] = await Promise.all([
      generationService.getForecast(farm, { refresh }),
      marketService.getForecast({ refresh }),
    ]);
    const optimizerResult = optimizeFarm({ farm, generationForecast, marketForecast });
    return { generationForecast, marketForecast, optimizerResult };
  }

  async function decisionFor(farm, optionsForRun = {}) {
    const pipeline = await pipelineFor(farm, optionsForRun);
    return decide({ farm, ...pipeline });
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
        const generation = modelReadiness();
        const marketConfigured = configuredMarketKey();
        const runtimeRuns = listAgentRuns();
        const latestSuccessful = agent => runtimeRuns.find(run => run.agent === agent && run.status === 'COMPLETED')?.generatedAt || null;
        const python = fs.existsSync(path.join(ROOT, '..', '.venv', 'bin', 'python')) ? path.join(ROOT, '..', '.venv', 'bin', 'python') : 'python3';
        const marketPackageReady = spawnSync(python, ['-c', 'import openai'], { timeout: 2000 }).status === 0;
        send(response, 200, {
          ok: generation.status === 'READY',
          checkedAt: new Date().toISOString(),
          components: {
            generationModel: { ...generation, lastSuccessfulRunAt: latestSuccessful('GENERATION_FORECAST') },
            marketAgent: { status: !marketConfigured ? 'CONFIGURATION_REQUIRED' : marketPackageReady ? 'READY' : 'UNAVAILABLE', providerConfigured: marketConfigured, pythonPackageReady: marketPackageReady, fallbackAvailable: true, lastSuccessfulRunAt: latestSuccessful('MARKET') },
            optimizer: { status: 'READY', source: 'SIMULATED', lastSuccessfulRunAt: latestSuccessful('OPTIMIZER') },
            decisionAgent: { status: 'READY', source: 'SIMULATED', mode: 'RULE_BASED', lastSuccessfulRunAt: latestSuccessful('DECISION') },
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/fleet') {
        send(response, 200, fleetSummary());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/farms') {
        send(response, 200, { farms, source: 'SIMULATED', generatedAt: new Date().toISOString() });
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
        send(response, 200, await generationService.getForecast(farm, { refresh }));
        return;
      }

      const farmMatch = url.pathname.match(/^\/api\/farms\/([^/]+)$/);
      if (request.method === 'GET' && farmMatch) {
        const farm = findFarm(farmMatch[1]);
        if (!farm) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmMatch[1]} does not exist.`);
          return;
        }
        send(response, 200, { ...farm, source: 'SIMULATED', generatedAt: new Date().toISOString() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/market/forecast') {
        send(response, 200, await marketService.getForecast({ refresh }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/optimizer/recommendations') {
        const farmId = url.searchParams.get('farmId');
        const selected = farmId ? [findFarm(farmId)].filter(Boolean) : farms;
        if (farmId && selected.length === 0) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmId} does not exist.`);
          return;
        }
        const results = await Promise.all(selected.map(farm => pipelineFor(farm, { refresh }).then(result => result.optimizerResult)));
        if (farmId) send(response, 200, results[0]);
        else {
          const candidates = results.flatMap(result => result.candidateStrategies.map(candidate => ({ farmId: result.farmId, ...candidate })));
          send(response, 200, { agent: 'OPTIMIZER', status: 'COMPLETED', generatedAt: new Date().toISOString(), results, candidateStrategies: candidates, recommendations: candidates });
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/decision/recommendation') {
        const farmId = url.searchParams.get('farmId');
        const selected = farmId ? [findFarm(farmId)].filter(Boolean) : farms;
        if (farmId && selected.length === 0) {
          apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmId} does not exist.`);
          return;
        }
        const decisions = await Promise.all(selected.map(farm => decisionFor(farm, { refresh })));
        send(response, 200, farmId ? decisions[0] : { agent: 'DECISION', status: 'COMPLETED', generatedAt: new Date().toISOString(), decisions });
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
        const farm = findFarm(recommendation.farmId);
        const before = { currentImportMW: farm.currentImportMW, currentExportMW: farm.currentExportMW, batterySocPct: farm.batterySocPct, revenueToday: farm.revenueToday };
        if (body.action === 'ACCEPT' && recommendation.decision === 'BUY') {
          const quantity = Math.min(recommendation.quantityMW, farm.gridImportLimitMW - farm.currentImportMW, farm.batteryMaxPowerMW);
          farm.currentImportMW = Number((farm.currentImportMW + quantity).toFixed(1));
          farm.batterySocPct = Number(Math.min(farm.batterySafeChargePct, farm.batterySocPct + quantity * 0.92 / farm.batteryCapacityMWh * 100).toFixed(1));
          farm.batteryPowerMW = Number((-quantity).toFixed(1));
        }
        if (body.action === 'ACCEPT' && recommendation.decision === 'SELL') {
          const quantity = Math.min(recommendation.quantityMW, farm.gridExportLimitMW - farm.currentExportMW, farm.batteryMaxPowerMW);
          const generationSurplus = Math.max(0, farm.currentGenerationMW - farm.currentExportMW, farm.curtailmentMW || 0);
          const discharge = Math.max(0, quantity - generationSurplus);
          farm.currentExportMW = Number((farm.currentExportMW + quantity).toFixed(1));
          farm.batterySocPct = Number(Math.max(farm.reservePct, farm.batterySocPct - discharge / 0.92 / farm.batteryCapacityMWh * 100).toFixed(1));
          farm.batteryPowerMW = Number(discharge.toFixed(1));
          farm.revenueToday = Math.round(farm.revenueToday + quantity * recommendation.marketPricePerMWh);
        }
        recommendation.executionStatus = body.action === 'ACCEPT' ? 'APPLIED' : 'DISMISSED';
        recommendation.executedAt = new Date().toISOString();
        recordActivity({
          type: body.action === 'ACCEPT' ? 'DECISION_ACCEPTED' : 'DECISION_DISMISSED',
          farmId: recommendation.farmId,
          message: `${recommendation.decision} ${recommendation.quantityMW} MW decision ${body.action.toLowerCase()}ed in simulation.`,
        });
        send(response, 200, { simulation: true, source: 'SIMULATED', status: recommendation.executionStatus, decisionId: recommendation.decisionId, before, after: { currentImportMW: farm.currentImportMW, currentExportMW: farm.currentExportMW, batterySocPct: farm.batterySocPct, revenueToday: farm.revenueToday } });
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
        send(response, 200, performanceFor(farms, url.searchParams.get('range') || 'today', farmId));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/freshness') {
        const runs = listAgentRuns();
        const latest = agent => runs.find(run => run.agent === agent)?.generatedAt || null;
        send(response, 200, {
          source: 'SIMULATED',
          checkedAt: new Date().toISOString(),
          telemetry: { updatedAt: new Date().toISOString(), source: 'SIMULATED' },
          weather: { updatedAt: new Date().toISOString(), source: 'HISTORICAL_DATASET' },
          grid: { updatedAt: new Date().toISOString(), source: 'SIMULATED' },
          generationForecast: { updatedAt: latest('GENERATION_FORECAST'), nextRunAt: runs.find(run => run.agent === 'GENERATION_FORECAST')?.nextRunAt || null, source: runs.find(run => run.agent === 'GENERATION_FORECAST')?.source || null },
          marketForecast: { updatedAt: latest('MARKET'), nextRunAt: runs.find(run => run.agent === 'MARKET')?.nextRunAt || null, source: runs.find(run => run.agent === 'MARKET')?.source || null },
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
      const isBadRequest = error instanceof TypeError;
      apiError(response, isBadRequest ? 400 : 500, isBadRequest ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', error.message);
    }
  });
}

if (require.main === module) {
  createApiServer().listen(PORT, () => console.log(`Solar/wind API and UI: http://localhost:${PORT}`));
}

module.exports = { createApiServer, fleetSummary, findFarm };

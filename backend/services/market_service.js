const fs = require('fs');
const path = require('path');
const { market: fallbackMarket } = require('../api_dashboard_data');
const { createBucketCache } = require('./cache_service');
const { createId, recordAgentRun, recordActivity } = require('./runtime_store');
const { runJsonProcess } = require('./subprocess_service');
const { startComponent, completeComponent, failComponent, recordFallback, cacheObserver } = require('./workflow_service');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKET_SCRIPT = path.join(ROOT, 'market_model', 'main.py');
const DEFAULT_PYTHON = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python'))
  ? path.join(ROOT, '.venv', 'bin', 'python')
  : 'python3';

function runMarketAgent({ python = DEFAULT_PYTHON, script = MARKET_SCRIPT } = {}) {
  return runJsonProcess({
    command: python,
    args: [script],
    cwd: path.dirname(script),
    env: process.env,
    timeoutMs: process.env.MARKET_PROCESS_TIMEOUT_MS || process.env.PYTHON_PROCESS_TIMEOUT_MS || 30000,
    maxOutputBytes: process.env.PYTHON_MAX_OUTPUT_BYTES || 1048576,
    retries: Number(process.env.MARKET_PROCESS_RETRIES || 0),
  }).then(result => result.data);
}

function validateMarketResult(value) {
  const allowedTrend = ['RISING', 'FALLING', 'STABLE'];
  const allowedLevel = ['LOW', 'MEDIUM', 'HIGH'];
  const allowedStatus = ['FAVORABLE', 'UNFAVORABLE', 'NEUTRAL'];
  if (!value || typeof value !== 'object') throw new Error('Market response must be an object');
  if (!Number.isFinite(value.currentPricePerMWh) || value.currentPricePerMWh < 0) throw new Error('Invalid currentPricePerMWh');
  const expectedHorizons = ['1h', '6h', '24h'];
  if (!Array.isArray(value.forecasts) || value.forecasts.length !== 3 || !expectedHorizons.every(horizon => value.forecasts.some(item => item.horizon === horizon))) throw new Error('Market forecasts must include exactly the 1h, 6h and 24h values');
  if (!value.forecasts.every(item => Number.isFinite(item.predictedPricePerMWh) && item.predictedPricePerMWh >= 0 && Number.isFinite(item.confidencePct) && item.confidencePct >= 0 && item.confidencePct <= 100)) throw new Error('Market forecast values or confidence are invalid');
  if (!allowedTrend.includes(value.trend)) throw new Error('Invalid market trend');
  if (!allowedStatus.includes(value.marketStatus)) throw new Error('Invalid market status');
  if (!allowedLevel.includes(value.riskLevel) || !allowedLevel.includes(value.newsImpact)) throw new Error('Invalid market risk/news level');
  if (!Number.isFinite(value.confidencePct) || value.confidencePct < 0 || value.confidencePct > 100) throw new Error('Invalid market confidence');
  if (!Number.isFinite(value.expectedPeakPricePerMWh) || value.expectedPeakPricePerMWh < 0 || typeof value.expectedPeakAt !== 'string') throw new Error('Invalid expected market peak');
  if (!Array.isArray(value.drivers) || value.drivers.length < 1 || value.drivers.length > 5 || !value.drivers.every(driver => typeof driver === 'string')) throw new Error('Market drivers must contain one to five strings');
  value.drivers = [...new Map(value.drivers.map(driver => [driver.trim().toLowerCase(), driver.trim()])).values()];
  const forbidden = ['battery_recommendation', 'batteryRecommendation', 'action', 'decision'];
  if (forbidden.some(field => Object.prototype.hasOwnProperty.call(value, field))) throw new Error('Market Agent returned an operational recommendation');
  return value;
}

function createMarketService({
  marketRunner = runMarketAgent,
  cache = createBucketCache(),
  now = () => Date.now(),
} = {}) {
  async function execute(workflowId = null) {
    const generatedAt = new Date(now()).toISOString();
    const agentRunId = createId('market-run');
    const execution = startComponent({ workflowId, component: 'MARKET', sourceType: 'MODEL_PREDICTION', modelName: process.env.DECISION_AI_MODEL || process.env.MARKET_AI_MODEL || 'gpt-5-mini', input: { inputArtifact: 'market_model/output/simulatedWorld.json' } });
    let response;
    let failure;
    try {
      const result = validateMarketResult(await marketRunner());
      response = {
        ...result,
        agent: 'MARKET',
        agentRunId,
        status: 'COMPLETED',
        generatedAt,
        updatedAt: generatedAt,
        nextRunAt: new Date((Math.floor(now() / 900000) + 1) * 900000).toISOString(),
        cacheExpiresAt: new Date((Math.floor(now() / 900000) + 1) * 900000).toISOString(),
        scheduled: false,
        nextScheduledRunAt: null,
        source: 'MARKET_AGENT',
        sourceType: 'MODEL_PREDICTION',
        priceUnit: 'INR_PER_MWH',
      };
      completeComponent(execution, { sourceType: response.sourceType, output: { currentPricePerMWh: response.currentPricePerMWh, forecasts: response.forecasts, trend: response.trend, source: response.source } });
    } catch (error) {
      failure = error;
      failComponent(execution, error);
      recordFallback({ workflowId, runId: execution.runId, component: 'MARKET', reason: error.message });
      response = {
        ...fallbackMarket,
        status: 'DEGRADED',
        agentRunId,
        generatedAt,
        updatedAt: generatedAt,
        nextRunAt: new Date((Math.floor(now() / 900000) + 1) * 900000).toISOString(),
        cacheExpiresAt: new Date((Math.floor(now() / 900000) + 1) * 900000).toISOString(),
        scheduled: false,
        nextScheduledRunAt: null,
        expectedPeakAt: new Date(now() + 3 * 60 * 60 * 1000).toISOString(),
        source: 'MOCK_FALLBACK',
        sourceType: 'FALLBACK',
        priceUnit: 'INR_PER_MWH',
      };
    }
    recordAgentRun({ agent: 'MARKET', agentRunId, status: response.status, source: response.source, generatedAt, nextRunAt: response.nextRunAt, error: failure?.message });
    recordActivity({ type: 'MARKET_FORECAST_UPDATED', message: `Market forecast updated from ${response.source}.` });
    return response;
  }

  function getForecast({ refresh = false, workflowId = null } = {}) {
    const currentTime = now();
    return cache.getOrCreate('market', () => execute(workflowId), {
      refresh,
      now: currentTime,
      observe: cacheObserver(workflowId, 'MARKET'),
    });
  }

  return { getForecast, cache };
}

module.exports = { createMarketService, runMarketAgent, validateMarketResult };

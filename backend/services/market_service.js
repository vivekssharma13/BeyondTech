const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { market: fallbackMarket } = require('../api_dashboard_data');
const { createBucketCache } = require('./cache_service');
const { createId, recordAgentRun, recordActivity } = require('./runtime_store');

const ROOT = path.resolve(__dirname, '..', '..');
const MARKET_SCRIPT = path.join(ROOT, 'market_model', 'main.py');
const DEFAULT_PYTHON = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python'))
  ? path.join(ROOT, '.venv', 'bin', 'python')
  : 'python3';

function runMarketAgent({ python = DEFAULT_PYTHON, script = MARKET_SCRIPT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd: path.dirname(script),
      env: process.env,
    });
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
        reject(new Error(error.trim() || 'Market Agent returned invalid JSON'));
        return;
      }
      if (code !== 0 || parsed.error) reject(new Error(parsed.error || error.trim() || 'Market Agent failed'));
      else resolve(parsed);
    });
  });
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
  async function execute() {
    const generatedAt = new Date(now()).toISOString();
    const agentRunId = createId('market-run');
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
        source: 'MARKET_AGENT',
      };
    } catch (error) {
      failure = error;
      response = {
        ...fallbackMarket,
        agentRunId,
        generatedAt,
        updatedAt: generatedAt,
        nextRunAt: new Date((Math.floor(now() / 900000) + 1) * 900000).toISOString(),
        expectedPeakAt: new Date(now() + 3 * 60 * 60 * 1000).toISOString(),
        source: 'MOCK_FALLBACK',
      };
    }
    recordAgentRun({ agent: 'MARKET', agentRunId, status: response.status, source: response.source, generatedAt, nextRunAt: response.nextRunAt, error: failure?.message });
    recordActivity({ type: 'MARKET_FORECAST_UPDATED', message: `Market forecast updated from ${response.source}.` });
    return response;
  }

  function getForecast({ refresh = false } = {}) {
    const currentTime = now();
    return cache.getOrCreate('market', execute, { refresh, now: currentTime });
  }

  return { getForecast, cache };
}

module.exports = { createMarketService, runMarketAgent, validateMarketResult };

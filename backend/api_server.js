const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { farms, seriesFor, forecastFor, market, alerts, agentRuns, performance, freshness } = require('./api_dashboard_data');

const ROOT = __dirname;
const MODEL_ROOT = path.join(ROOT, '..', 'model');
const PORT = Number(process.env.PORT || 3000);
const python = fs.existsSync(path.join(ROOT, '..', '.venv', 'bin', 'python'))
  ? path.join(ROOT, '..', '.venv', 'bin', 'python')
  : 'python3';

function send(response, status, body, type = 'application/json') {
  response.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function apiError(response, status, code, message) {
  send(response, status, { error: { code, message, timestamp: new Date().toISOString() } });
}

function fleetSummary() {
  const totals = farms.reduce((sum, farm) => ({
    generation: sum.generation + farm.currentGenerationMW,
    forecast: sum.forecast + farm.forecastGenerationMW,
    capacity: sum.capacity + farm.capacityMW,
    availability: sum.availability + farm.availabilityPct,
    export: sum.export + farm.currentExportMW,
    limit: sum.limit + farm.gridExportLimitMW,
    batteryCapacity: sum.batteryCapacity + farm.batteryCapacityMWh,
    revenue: sum.revenue + farm.revenueToday,
  }), { generation: 0, forecast: 0, capacity: 0, availability: 0, export: 0, limit: 0, batteryCapacity: 0, revenue: 0 });
  return {
    generatedAt: new Date().toISOString(),
    liveGenerationMW: Number(totals.generation.toFixed(1)),
    forecastGenerationMW: Number(totals.forecast.toFixed(1)),
    installedCapacityMW: totals.capacity,
    fleetUtilizationPct: Number((totals.generation / totals.capacity * 100).toFixed(1)),
    fleetAvailabilityPct: Number((totals.availability / farms.length).toFixed(1)),
    grid: { currentExportMW: Number(totals.export.toFixed(1)), exportLimitMW: totals.limit, headroomMW: Number((totals.limit - totals.export).toFixed(1)) },
    storage: { totalCapacityMWh: totals.batteryCapacity, socPct: 68 },
    revenueToday: totals.revenue,
    activeAlerts: 4,
  };
}

function optimizerRecommendations(farmId) {
  const selected = farmId ? farms.filter(farm => farm.farmId === farmId) : farms;
  return {
    agent: 'OPTIMIZER', agentRunId: 'optimizer-run-412', status: 'COMPLETED', generatedAt: '2026-10-08T12:45:00Z',
    recommendations: selected.filter(farm => farm.type === 'SOLAR').map(farm => ({
      recommendationId: `rec-${farm.farmId}`, farmId: farm.farmId, action: 'INCREASE_BATTERY_RESERVE', currentValue: farm.reservePct, recommendedValue: 30, unit: 'PERCENT', confidencePct: 86,
      reason: 'Solar generation is forecast to decline while electricity prices are expected to rise.', constraintsConsidered: ['generationForecast', 'marketForecast', 'batterySoc', 'batteryCapacity', 'gridCapacity'],
    })),
  };
}

function predict(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(MODEL_ROOT, 'predict.py')]);
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      let parsed;
      try { parsed = JSON.parse(output); } catch { reject(new Error(error || 'Prediction process returned invalid JSON')); return; }
      if (code !== 0 || parsed.error) reject(new Error(parsed.error || error || 'Prediction failed'));
      else resolve(parsed);
    });
    child.stdin.end(JSON.stringify(body));
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') { send(response, 204, ''); return; }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    send(response, 200, { ok: true, python });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/fleet') {
    send(response, 200, fleetSummary());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/farms') {
    send(response, 200, { farms });
    return;
  }
  const farmMatch = url.pathname.match(/^\/api\/farms\/([^/]+)$/);
  if (request.method === 'GET' && farmMatch) {
    const farm = farms.find(item => item.farmId === farmMatch[1]);
    if (!farm) { apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${farmMatch[1]} does not exist.`); return; }
    send(response, 200, farm);
    return;
  }
  const generationMatch = url.pathname.match(/^\/api\/farms\/([^/]+)\/generation$/);
  if (request.method === 'GET' && generationMatch) {
    const farm = farms.find(item => item.farmId === generationMatch[1]);
    if (!farm) { apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${generationMatch[1]} does not exist.`); return; }
    send(response, 200, { farmId: farm.farmId, interval: url.searchParams.get('interval') || '15m', data: seriesFor(farm) });
    return;
  }
  const forecastMatch = url.pathname.match(/^\/api\/farms\/([^/]+)\/forecast$/);
  if (request.method === 'GET' && forecastMatch) {
    const farm = farms.find(item => item.farmId === forecastMatch[1]);
    if (!farm) { apiError(response, 404, 'FARM_NOT_FOUND', `Farm ${forecastMatch[1]} does not exist.`); return; }
    send(response, 200, forecastFor(farm));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/market/forecast') {
    send(response, 200, market);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/optimizer/recommendations') {
    send(response, 200, optimizerRecommendations(url.searchParams.get('farmId')));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/alerts') { send(response, 200, { alerts }); return; }
  if (request.method === 'GET' && url.pathname === '/api/agent-runs') { send(response, 200, { agent: 'GENERATION_FORECAST', runs: agentRuns }); return; }
  if (request.method === 'GET' && url.pathname === '/api/performance') { send(response, 200, performance); return; }
  if (request.method === 'GET' && url.pathname === '/api/freshness') { send(response, 200, freshness); return; }
  if (request.method === 'POST' && url.pathname === '/api/predict') {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        if (!body.date) throw new Error('date is required');
        send(response, 200, await predict(body));
      } catch (error) {
        send(response, 400, { error: error.message });
      }
    });
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
});

server.listen(PORT, () => console.log(`Solar/wind API and UI: http://localhost:${PORT}`));
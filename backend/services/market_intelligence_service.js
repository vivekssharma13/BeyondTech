const fs = require('node:fs');
const path = require('node:path');
const { runJsonProcess } = require('./subprocess_service');
const { startComponent, completeComponent, failComponent, createIdentifier } = require('./workflow_service');
const { getDatabase, json } = require('./database_service');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'market_model', 'main.py');
const PYTHON = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python')) ? path.join(ROOT, '.venv', 'bin', 'python') : 'python3';

function evidenceFromOutlook(outlook) {
  return {
    marketId: outlook.marketId, mode: outlook.mode, scenarioId: outlook.scenarioId, sourceType: outlook.sourceType,
    generatedAt: outlook.generatedAt, priceUnit: outlook.priceUnit, summary: outlook.summary,
    hourlyTrajectory: outlook.hourlyIntervals.map(item => ({ intervalStart: item.intervalStart, intervalEnd: item.intervalEnd, priceINRPerMWh: item.priceINRPerMWh, sourceTypes: item.sourceTypes })),
    limitations: ['Fictional shared reference price; congestion-based regional prices are not represented.', 'No calibrated numerical uncertainty is available for deterministic simulation.'],
  };
}

async function analyzeMarketOutlook(outlook, { workflowId = null, runner = runJsonProcess } = {}) {
  if (!outlook || outlook.status !== 'READY') return { status: 'UNAVAILABLE', sourceType: 'UNAVAILABLE', analysis: null, error: 'A ready numerical market outlook is required.' };
  const evidence = evidenceFromOutlook(outlook);
  const model = process.env.MARKET_AI_MODEL || process.env.DECISION_AI_MODEL || 'gpt-5-mini';
  const execution = startComponent({ workflowId, component: 'AI_MARKET_INTELLIGENCE', sourceType: 'AI_REASONING', modelName: model, input: { marketSimulationRunId: outlook.marketSimulationRunId, evidence } });
  const intelligenceRunId = createIdentifier('market-intelligence');
  try {
    const result = await runner({ command: PYTHON, args: [SCRIPT], cwd: path.dirname(SCRIPT), env: process.env, input: evidence, timeoutMs: process.env.MARKET_PROCESS_TIMEOUT_MS || 30000, maxOutputBytes: 1048576, retries: Number(process.env.MARKET_PROCESS_RETRIES || 0) });
    const analysis = result.data;
    const generatedAt = new Date().toISOString();
    getDatabase().prepare(`INSERT INTO market_intelligence_runs
      (intelligence_run_id, market_definition_id, workflow_id, status, provider, model_name, source_type, generated_at, input_references_json, output_json)
      VALUES (?, 'INDIA_SIMULATED_REFERENCE_MARKET:v1', ?, 'COMPLETED', 'OPENAI_COMPATIBLE', ?, 'AI_REASONING', ?, ?, ?)`)
      .run(intelligenceRunId, workflowId, model, generatedAt, json({ marketSimulationRunId: outlook.marketSimulationRunId }), json(analysis));
    completeComponent(execution, { status: 'COMPLETED', sourceType: 'AI_REASONING', output: { intelligenceRunId, trend: analysis.trend, riskLevel: analysis.riskLevel } });
    return { status: 'READY', intelligenceRunId, sourceType: 'AI_REASONING', model, generatedAt, analysis };
  } catch (error) {
    failComponent(execution, error);
    return { status: 'DEGRADED', intelligenceRunId, sourceType: 'UNAVAILABLE', model, generatedAt: new Date().toISOString(), analysis: null, error: error.message };
  }
}

module.exports = { evidenceFromOutlook, analyzeMarketOutlook };

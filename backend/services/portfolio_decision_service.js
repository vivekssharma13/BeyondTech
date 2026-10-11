const OpenAI = require('openai');
const { getActiveConfiguration, missingDecisionAgentAssumptions } = require('./configuration_service');
const { optimizePortfolio } = require('./portfolio_optimizer_service');
const { startComponent, completeComponent, failComponent, recordEvent, createIdentifier } = require('./workflow_service');
const { saveDecision, createId, recordAgentRun, recordActivity } = require('./runtime_store');
const { getPersistedFarmState } = require('./simulation_state_service');

const STRATEGY_CANDIDATES = ['BALANCED', 'PROFIT_FOCUS', 'CONSERVATIVE', 'GREEN_FOCUS'];
const DEFAULT_SCENARIOS = ['BALANCED', 'PROFIT_FOCUS', 'GREEN_FOCUS'];

function comparison(plans) {
  return plans.map(plan => ({
    optimizerRunId: plan.optimizerRunId, strategyName: plan.strategyName, solverStatus: plan.solverStatus,
    projectedNetValueINR: plan.totals.projectedNetValueINR, renewableUtilizationPct: plan.totals.renewableUtilizationPct,
    curtailedMWh: plan.totals.curtailedMWh, importedMWh: plan.totals.importedMWh,
    batteryDischargeMWh: plan.totals.batteryDischargeMWh,
  }));
}

function selectDeterministic(plans) {
  return [...plans].sort((a, b) => {
    const aScore = a.totals.projectedNetValueINR + a.totals.renewableUtilizationPct * 1000 - a.totals.curtailedMWh * 100;
    const bScore = b.totals.projectedNetValueINR + b.totals.renewableUtilizationPct * 1000 - b.totals.curtailedMWh * 100;
    return bScore - aScore;
  })[0];
}

function decisionEvidenceScore({ selected, plans }) {
  const horizonComplete = selected.allocations?.length === 288;
  const components = {
    optimalSolverResult: selected.solverStatus === 'OPTIMAL' ? 30 : 0,
    independentConstraintValidation: selected.validation?.valid ? 25 : 0,
    complete72HourInputs: horizonComplete ? 20 : 0,
    scenarioCoverage: Math.min(15, plans.length * 5),
    calibratedForecastUncertainty: 0,
  };
  const scorePct = Object.values(components).reduce((sum, value) => sum + value, 0);
  return {
    scorePct,
    label: scorePct >= 85 ? 'STRONG' : scorePct >= 70 ? 'GOOD' : scorePct >= 50 ? 'LIMITED' : 'LOW',
    type: 'DECISION_EVIDENCE_SCORE',
    calibratedProbability: false,
    components,
    explanation: 'Evidence score based on solver optimality, constraint validation, complete 72-hour inputs, and evaluated strategy coverage. It is not a probability of financial outcome.',
  };
}

function validateDecisionReasoning(value) {
  const isStringArray = (items, minimum, maximum) => Array.isArray(items)
    && items.length >= minimum
    && items.length <= maximum
    && items.every(item => typeof item === 'string' && item.trim().length > 0);
  if (!value || typeof value.selectedOptimizerRunId !== 'string'
    || !isStringArray(value.reasons, 1, 5)
    || !isStringArray(value.tradeoffs, 1, 5)
    || !isStringArray(value.warnings, 0, 10)) {
    throw Object.assign(new Error('Decision Agent response does not match the required structured schema'), { code: 'AI_INVALID_OUTPUT' });
  }
  return value;
}

function providerConfig() {
  return {
    apiKey: process.env.DECISION_AI_API_KEY || process.env.OPENAI_API_KEY || null,
    baseURL: process.env.DECISION_AI_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
    model: process.env.DECISION_AI_MODEL || 'gpt-5-mini',
  };
}

function portfolioDecisionFromSelection({ selected, plans, workflowId, active, reasoning, sourceType, model, degraded, toolCalls }) {
  const firstHour = selected.allocations.filter(row => row.hourIndex === 0);
  const generatedAt = new Date().toISOString();
  const agentRunId = createId('portfolio-decision');
  const decision = {
    agent: 'OPENAI_DECISION_AGENT', agentRunId, decisionId: agentRunId, workflowId, status: degraded ? 'DEGRADED' : 'COMPLETED',
    executionStatus: 'PENDING', generatedAt, source: degraded ? 'DETERMINISTIC_FALLBACK' : 'OPENAI', sourceType,
    model, selectedStrategy: selected.strategyName, selectedScenarioId: selected.optimizerRunId,
    optimizerRunId: selected.optimizerRunId, strategyComparison: comparison(plans), plan: selected,
    firstHourAllocations: firstHour, expectedSimulatedEconomics: selected.totals,
    reasons: reasoning.reasons, tradeoffs: reasoning.tradeoffs, warnings: [...selected.warnings, ...(reasoning.warnings || [])],
    confidence: decisionEvidenceScore({ selected, plans }),
    inputProvenance: { generationRunIds: selected.inputSnapshotId, marketScenarioId: selected.scenarioId, marketSourceType: 'DETERMINISTIC_MARKET_SIMULATION' },
    configurationVersion: active.configVersion, validation: selected.validation, approvalStatus: 'PENDING',
    toolCalls,
    farmId: 'fleet', decision: 'PORTFOLIO_PLAN', quantityMW: firstHour.reduce((sum, row) => sum + row.directExportMWh + row.batteryDischargeMWh, 0),
    marketPricePerMWh: firstHour[0]?.priceINRPerMWh ?? null,
    inputStateVersions: Object.fromEntries(firstHour.map(row => [row.farmId, getPersistedFarmState(row.farmId)?.stateVersion ?? null])),
  };
  saveDecision(decision);
  return decision;
}

async function runOpenAIDecision({ farms, generationOutlooks, marketOutlook, workflowId, active, optimizer = optimizePortfolio, clientFactory = options => new OpenAI(options) }) {
  const provider = providerConfig();
  if (!provider.apiKey) throw Object.assign(new Error('Decision AI API key is not configured'), { code: 'AI_CONFIGURATION_REQUIRED' });
  const limits = active.configuration.aiLimits;
  const maximumToolCalls = Math.min(3, limits.maximumToolCalls.value);
  const estimatedCost = Number(process.env.DECISION_AI_ESTIMATED_REQUEST_COST_MINOR_UNITS);
  if (!Number.isFinite(estimatedCost) || estimatedCost < 0) throw Object.assign(new Error('DECISION_AI_ESTIMATED_REQUEST_COST_MINOR_UNITS is required to enforce the configured cost ceiling'), { code: 'AI_COST_ESTIMATE_REQUIRED' });
  if (estimatedCost > limits.maximumCostMinorUnits.value) throw Object.assign(new Error('Estimated Decision Agent request cost exceeds the configured ceiling'), { code: 'AI_COST_CEILING_EXCEEDED' });
  const client = clientFactory({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  const tools = [{ type: 'function', name: 'evaluateOptimizationScenario', description: 'Solve one configured 72-hour fleet MILP strategy. Quantities returned by this tool are authoritative.', strict: true, parameters: { type: 'object', additionalProperties: false, properties: { strategyName: { type: 'string', enum: STRATEGY_CANDIDATES } }, required: ['strategyName'] } }];
  const prompt = `You are the Gridline AI portfolio Decision Agent. Choose up to ${maximumToolCalls} materially useful strategies to evaluate. Compare only feasible solver outputs. Never invent quantities or prices. End with JSON containing selectedOptimizerRunId, reasons (1-5 strings), tradeoffs (1-5 strings), warnings (array). This is a fictional simulation requiring human approval.\nMarket: ${JSON.stringify({ scenarioId: marketOutlook.scenarioId, summary: marketOutlook.summary, sourceType: marketOutlook.sourceType })}\nFleet: ${JSON.stringify(farms.map(farm => ({ farmId: farm.farmId, batterySocPct: farm.batterySocPct, reservePct: farm.reservePct, gridExportLimitMW: farm.gridExportLimitMW, gridImportLimitMW: farm.gridImportLimitMW })))}.`;
  const plans = [];
  const seen = new Set();
  const toolTrace = [];
  let input = prompt;
  let response;
  const maximumResponses = maximumToolCalls + 1;
  const perResponseOutputTokens = Math.max(256, Math.floor(limits.maximumOutputTokens.value / maximumResponses));
  const request = async payload => {
    let lastError;
    for (let attempt = 0; attempt <= limits.retryLimit.value; attempt += 1) {
      try { return await Promise.race([client.responses.create(payload), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Decision Agent timed out'), { code: 'AI_TIMEOUT' })), limits.timeoutMs.value))]); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  };
  for (let iteration = 0; iteration <= maximumToolCalls; iteration += 1) {
    response = await request({ model: provider.model, input, tools, max_output_tokens: perResponseOutputTokens });
    const calls = (response.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      if (plans.length >= maximumToolCalls) throw Object.assign(new Error('Decision Agent exceeded maximum optimizer scenarios'), { code: 'AI_TOOL_LIMIT_EXCEEDED' });
      const args = JSON.parse(call.arguments || '{}');
      if (!STRATEGY_CANDIDATES.includes(args.strategyName) || seen.has(args.strategyName)) throw Object.assign(new Error('Decision Agent requested an invalid or duplicate strategy'), { code: 'AI_INVALID_TOOL_ARGUMENTS' });
      const plan = optimizer({ farms, generationOutlooks, marketOutlook, strategyName: args.strategyName, workflowId });
      if (plan.status !== 'OPTIMAL') throw Object.assign(new Error(`Optimizer returned ${plan.status}`), { code: 'OPTIMIZER_NOT_FEASIBLE' });
      plans.push(plan); seen.add(args.strategyName);
      const result = { optimizerRunId: plan.optimizerRunId, strategyName: plan.strategyName, solverStatus: plan.solverStatus, totals: plan.totals, validation: plan.validation };
      toolTrace.push({ tool: call.name, arguments: args, result });
      recordEvent({ workflowId, component: 'OPENAI_DECISION_AGENT', eventType: 'TOOL_CALL_COMPLETED', status: 'COMPLETED', metadata: { tool: call.name, arguments: args, result } });
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
    input = [...(response.output || []), ...outputs];
  }
  if (!plans.length) throw Object.assign(new Error('Decision Agent did not evaluate an optimization scenario'), { code: 'AI_NO_SCENARIO_EVALUATED' });
  let final;
  try { final = validateDecisionReasoning(JSON.parse(response.output_text)); } catch (error) {
    if (error.code === 'AI_INVALID_OUTPUT') throw error;
    throw Object.assign(new Error('Decision Agent returned invalid structured JSON'), { code: 'AI_INVALID_OUTPUT' });
  }
  const selected = plans.find(plan => plan.optimizerRunId === final.selectedOptimizerRunId);
  if (!selected) throw Object.assign(new Error('Decision Agent selected a plan that was not evaluated'), { code: 'AI_INVALID_SELECTION' });
  return portfolioDecisionFromSelection({ selected, plans, workflowId, active, reasoning: final, sourceType: 'AI_REASONING', model: provider.model, degraded: false, toolCalls: toolTrace });
}

async function createPortfolioDecision({ farms, generationOutlooks, marketOutlook, workflowId = null, optimizer = optimizePortfolio, clientFactory } = {}) {
  const active = getActiveConfiguration();
  const missing = missingDecisionAgentAssumptions(active.configuration);
  if (missing.length) return { agent: 'OPENAI_DECISION_AGENT', status: 'INCOMPLETE_ASSUMPTIONS', missing, executionStatus: 'NOT_CREATED', generatedAt: new Date().toISOString() };
  const execution = startComponent({ workflowId, component: 'OPENAI_DECISION_AGENT', sourceType: 'AI_REASONING', modelName: providerConfig().model, input: { maximumToolCalls: Math.min(3, active.configuration.aiLimits.maximumToolCalls.value), costCeilingMinorUnits: active.configuration.aiLimits.maximumCostMinorUnits.value } });
  try {
    let decision;
    try {
      decision = await runOpenAIDecision({ farms, generationOutlooks, marketOutlook, workflowId, active, optimizer, clientFactory });
    } catch (error) {
      if (!active.configuration.aiLimits.allowDeterministicFallback.value) throw error;
      const plans = DEFAULT_SCENARIOS.slice(0, Math.min(3, active.configuration.aiLimits.maximumToolCalls.value)).map(strategyName => optimizer({ farms, generationOutlooks, marketOutlook, strategyName, workflowId }));
      if (plans.some(plan => plan.status !== 'OPTIMAL')) throw Object.assign(new Error('Deterministic fallback received a non-optimal solver result'), { code: 'FALLBACK_OPTIMIZER_FAILED' });
      const selected = selectDeterministic(plans);
      decision = portfolioDecisionFromSelection({ selected, plans, workflowId, active, degraded: true, sourceType: 'USER_CONFIGURED_SIMULATION', model: 'DETERMINISTIC_PLAN_SELECTOR_V1', toolCalls: plans.map(plan => ({ tool: 'evaluateOptimizationScenario', arguments: { strategyName: plan.strategyName }, result: { optimizerRunId: plan.optimizerRunId, totals: plan.totals } })), reasoning: { reasons: ['Configured deterministic fallback selected the highest combined simulated economic value and renewable-utilization score.'], tradeoffs: ['The fallback cannot provide contextual AI judgment. Human approval remains mandatory.'], warnings: [`OpenAI path unavailable: ${error.code || error.message}`] } });
      recordEvent({ workflowId, runId: execution.runId, component: 'OPENAI_DECISION_AGENT', eventType: 'DETERMINISTIC_FALLBACK_USED', status: 'DEGRADED', metadata: { reason: error.message, evaluatedScenarios: plans.length } });
    }
    completeComponent(execution, { status: decision.status, sourceType: decision.sourceType, output: { decisionId: decision.decisionId, selectedStrategy: decision.selectedStrategy, optimizerRunId: decision.optimizerRunId, scenarioCount: decision.strategyComparison.length } });
    recordAgentRun({ agent: 'OPENAI_DECISION_AGENT', agentRunId: decision.agentRunId, status: decision.status, source: decision.source, generatedAt: decision.generatedAt });
    recordActivity({ type: 'PORTFOLIO_DECISION_PROPOSED', message: `${decision.selectedStrategy} 72-hour portfolio plan awaits human approval.` });
    return decision;
  } catch (error) {
    failComponent(execution, error);
    throw error;
  }
}

module.exports = { STRATEGY_CANDIDATES, comparison, selectDeterministic, decisionEvidenceScore, validateDecisionReasoning, createPortfolioDecision, runOpenAIDecision };

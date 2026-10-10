const { createId, recordAgentRun, recordActivity, saveDecision } = require('./runtime_store');
const { clamp } = require('./optimizer_service');

const DECISION_CONFIG = Object.freeze({
  weights: {
    BUY: { futurePriceUpside: 0.30, batteryAvailableCapacity: 0.20, generationShortfall: 0.20, gridImportHeadroom: 0.15, combinedForecastConfidence: 0.15 },
    SELL: { currentPriceOpportunity: 0.30, batteryReserveMargin: 0.20, gridExportHeadroom: 0.20, generationSurplus: 0.15, combinedForecastConfidence: 0.15 },
    HOLD: { forecastUncertainty: 0.30, weakPriceSpread: 0.25, tightReserve: 0.20, conflictingSignals: 0.15, candidateScoreCloseness: 0.10 },
  },
  closeScoreThreshold: 8,
  lowConfidenceThreshold: 60,
  priceSpreadFullSignalPct: 25,
  generationDeltaFullSignalPct: 30,
  reserveMarginFullSignalPct: 30,
});

const round = value => Math.round(clamp(value, 0, 100));
const ratioPct = (numerator, denominator) => numerator / Math.max(Math.abs(denominator), 0.1) * 100;
const signal = (value, fullSignal) => clamp(value / fullSignal * 100, 0, 100);

function horizon(items, name, valueField, confidenceField = 'confidencePct') {
  const item = items.find(entry => entry.horizon === name) || {};
  return { value: Number(item[valueField] || 0), confidence: Number(item[confidenceField] || 0) };
}

function weightedScore(signals, weights) {
  return round(Object.entries(weights).reduce((total, [key, weight]) => total + signals[key] * weight, 0));
}

function decide({ farm, optimizerResult, generationForecast, marketForecast, now = Date.now(), config = DECISION_CONFIG }) {
  const generation1h = horizon(generationForecast.horizons, '1h', 'predictedGenerationMW');
  const generation6h = horizon(generationForecast.horizons, '6h', 'predictedGenerationMW');
  const price1h = horizon(marketForecast.forecasts, '1h', 'predictedPricePerMWh');
  const price6h = horizon(marketForecast.forecasts, '6h', 'predictedPricePerMWh');
  const generationConfidence = (generation1h.confidence + generation6h.confidence) / 2;
  const marketConfidence = Number(marketForecast.confidencePct ?? (price1h.confidence + price6h.confidence) / 2);
  const combinedConfidence = clamp((generationConfidence + marketConfidence) / 2, 0, 100);
  const priceSpread6hPct = ratioPct(price6h.value - marketForecast.currentPricePerMWh, marketForecast.currentPricePerMWh);
  const generationDelta6hPct = ratioPct(generation6h.value - farm.currentGenerationMW, farm.currentGenerationMW);
  const reserveMarginPct = farm.batterySocPct - farm.reservePct;
  const exportHeadroomPct = farm.gridExportLimitMW > 0 ? ratioPct(farm.gridExportLimitMW - farm.currentExportMW, farm.gridExportLimitMW) : 0;
  const importHeadroomPct = farm.gridImportLimitMW > 0 ? ratioPct(farm.gridImportLimitMW - farm.currentImportMW, farm.gridImportLimitMW) : 0;
  const batteryAvailableCapacityPct = clamp((farm.batterySafeChargePct ?? 95) - farm.batterySocPct, 0, 100);
  const sellCandidate = optimizerResult.candidateStrategies.find(candidate => candidate.action === 'SELL');

  const buySignals = {
    futurePriceUpside: signal(Math.max(0, priceSpread6hPct), config.priceSpreadFullSignalPct),
    batteryAvailableCapacity: signal(batteryAvailableCapacityPct, 50),
    generationShortfall: signal(Math.max(0, -generationDelta6hPct), config.generationDeltaFullSignalPct),
    gridImportHeadroom: clamp(importHeadroomPct, 0, 100),
    combinedForecastConfidence: combinedConfidence,
  };
  const sellSignals = {
    currentPriceOpportunity: signal(Math.max(0, -priceSpread6hPct), config.priceSpreadFullSignalPct),
    batteryReserveMargin: signal(Math.max(0, reserveMarginPct), config.reserveMarginFullSignalPct),
    gridExportHeadroom: clamp(exportHeadroomPct, 0, 100),
    generationSurplus: signal((sellCandidate?.quantityMW || 0) / Math.max(farm.capacityMW, 0.1) * 100, 25),
    combinedForecastConfidence: combinedConfidence,
  };
  const buyScore = weightedScore(buySignals, config.weights.BUY);
  const sellScore = weightedScore(sellSignals, config.weights.SELL);
  const priceSignalDirection = Math.sign(priceSpread6hPct);
  const generationSignalDirection = Math.sign(generationDelta6hPct);
  const conflictingSignals = priceSignalDirection !== 0 && generationSignalDirection !== 0 && priceSignalDirection === generationSignalDirection ? 100 : 30;
  const holdSignals = {
    forecastUncertainty: 100 - combinedConfidence,
    weakPriceSpread: 100 - signal(Math.abs(priceSpread6hPct), config.priceSpreadFullSignalPct),
    tightReserve: 100 - signal(Math.max(0, reserveMarginPct), config.reserveMarginFullSignalPct),
    conflictingSignals,
    candidateScoreCloseness: 100 - clamp(Math.abs(buyScore - sellScore) / config.closeScoreThreshold * 100, 0, 100),
  };
  const scores = { BUY: buyScore, SELL: sellScore, HOLD: weightedScore(holdSignals, config.weights.HOLD) };
  const feasible = optimizerResult.candidateStrategies.filter(candidate => candidate.feasible);
  if (feasible.length === 0) throw new Error('Optimizer returned no feasible candidates');

  let winner;
  if (feasible.length === 1) {
    [winner] = feasible;
  } else {
    winner = [...feasible].sort((a, b) => scores[b.action] - scores[a.action])[0];
    const hold = feasible.find(candidate => candidate.action === 'HOLD');
    const buy = feasible.find(candidate => candidate.action === 'BUY');
    const sell = feasible.find(candidate => candidate.action === 'SELL');
    if (hold && buy && sell && Math.abs(scores.BUY - scores.SELL) < config.closeScoreThreshold) winner = hold;
    if (hold && combinedConfidence < config.lowConfidenceThreshold) winner = hold;
    if (hold && marketForecast.riskLevel === 'HIGH') winner = hold;
  }

  const rankedValidScores = feasible.map(candidate => scores[candidate.action]).sort((a, b) => b - a);
  const scoreGap = Math.abs(scores[winner.action] - (rankedValidScores.find(score => score !== scores[winner.action]) ?? scores[winner.action]));
  const confidencePct = round(scores[winner.action] * 0.5 + Math.min(scoreGap * 2, 100) * 0.25 + combinedConfidence * 0.25);
  const argumentsFor = [];
  const argumentsAgainst = [];
  if (winner.action === 'BUY') {
    argumentsFor.push(`The 6-hour price forecast is ${Math.abs(priceSpread6hPct).toFixed(1)}% above the current price.`);
    argumentsFor.push(`Battery storage has ${batteryAvailableCapacityPct.toFixed(1)} percentage points of safe capacity available.`);
    argumentsFor.push(`Grid import headroom supports the optimizer-approved ${winner.quantityMW} MW.`);
    if (generationDelta6hPct >= 0) argumentsAgainst.push('Generation is not forecast to decline over the next 6 hours.');
  } else if (winner.action === 'SELL') {
    argumentsFor.push(`The 6-hour price forecast is ${Math.abs(priceSpread6hPct).toFixed(1)}% below the current price.`);
    argumentsFor.push(`Battery SOC is ${reserveMarginPct.toFixed(1)} percentage points above reserve.`);
    argumentsFor.push(`Grid export headroom supports the optimizer-approved ${winner.quantityMW} MW.`);
    if (generationDelta6hPct < 0) argumentsAgainst.push('Generation is expected to decline over the next 6 hours.');
  } else {
    argumentsFor.push('Holding preserves flexibility while market and generation signals are uncertain or closely balanced.');
    if (combinedConfidence < config.lowConfidenceThreshold) argumentsFor.push(`Combined forecast confidence is only ${combinedConfidence.toFixed(0)}%.`);
    if (Math.abs(scores.BUY - scores.SELL) < config.closeScoreThreshold) argumentsFor.push('BUY and SELL scores are too close for a directional recommendation.');
    argumentsAgainst.push('Holding may defer a short-term market opportunity.');
  }

  const agentRunId = createId('decision-run');
  const result = {
    agent: 'DECISION',
    agentRunId,
    decisionId: agentRunId,
    status: 'COMPLETED',
    generatedAt: new Date(now).toISOString(),
    source: 'SIMULATED',
    logic: 'RULE_BASED',
    executionStatus: 'PENDING',
    marketPricePerMWh: marketForecast.currentPricePerMWh,
    farmId: farm.farmId,
    inputs: {
      optimizerRunId: optimizerResult.agentRunId,
      generationForecastRunId: generationForecast.agentRunId,
      marketForecastRunId: marketForecast.agentRunId,
    },
    decision: winner.action,
    quantityMW: winner.quantityMW,
    confidencePct,
    scores,
    argumentsFor,
    argumentsAgainst,
    reason: `${winner.action} ${winner.quantityMW} MW is the strongest valid option after applying forecast, battery, grid and conservative safety rules.`,
  };
  saveDecision(result);
  recordAgentRun({ agent: 'DECISION', agentRunId, farmId: farm.farmId, status: 'COMPLETED', source: result.source, generatedAt: result.generatedAt });
  recordActivity({ type: 'DECISION_GENERATED', farmId: farm.farmId, message: `Decision Agent recommended ${winner.action} ${winner.quantityMW} MW with ${confidencePct}% confidence.` });
  return result;
}

module.exports = { DECISION_CONFIG, decide, weightedScore };

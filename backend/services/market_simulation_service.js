const crypto = require('node:crypto');
const { getDatabase, transaction, json } = require('./database_service');
const { getActiveConfiguration } = require('./configuration_service');
const { REFERENCE_MARKET_DEFINITION, stableJson, marketDefinitionId } = require('./market_contract_service');
const { aggregateMarketIntervalsToHours, marketDataReadiness } = require('./market_data_service');
const { createIdentifier, startComponent, completeComponent, failComponent } = require('./workflow_service');
const { createId, recordAgentRun, recordActivity } = require('./runtime_store');

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SOURCE_TYPE = 'DETERMINISTIC_MARKET_SIMULATION';
const MODEL_VERSION = 'deterministic-market-v1';

function validatePlanningIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length !== 72) throw new TypeError('Exactly 72 generation planning intervals are required');
  return intervals.map((interval, index) => {
    const start = Date.parse(interval.intervalStart);
    const end = Date.parse(interval.intervalEnd);
    if (!Number.isFinite(start) || end - start !== HOUR_MS || start % QUARTER_HOUR_MS !== 0) throw new TypeError(`Planning interval ${index + 1} is not an aligned one-hour interval`);
    if (index && start !== Date.parse(intervals[index - 1].intervalEnd)) throw new TypeError(`Planning interval ${index + 1} is not consecutive`);
    return { intervalStart: new Date(start).toISOString(), intervalEnd: new Date(end).toISOString() };
  });
}

function localHourDecimal(epochMs) {
  const date = new Date(epochMs + 5.5 * HOUR_MS);
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

function circularPeak(hour, center, width) {
  const distance = Math.min(Math.abs(hour - center), 24 - Math.abs(hour - center));
  return Math.exp(-(distance ** 2) / (2 * width ** 2));
}

function configuredEventAdder(events, hourIndex) {
  return (events || []).filter(event => hourIndex >= event.startHour && hourIndex < event.startHour + event.durationHours)
    .reduce((sum, event) => sum + event.priceAdderINRPerMWh, 0);
}

function generateDeterministicPrices({ planningIntervals, scenario, generationOutlooks = [], scenarioId, scenarioVersion }) {
  const hours = validatePlanningIntervals(planningIntervals);
  const totalCapacityMW = generationOutlooks.reduce((sum, outlook) => sum + Number(outlook.installedCapacityMW || 0), 0);
  const generationByHour = hours.map((_, hourIndex) => generationOutlooks.reduce((sum, outlook) => sum + Number(outlook.intervals?.[hourIndex]?.predictedGenerationMW || 0), 0));
  const nativeIntervals = [];
  for (let hourIndex = 0; hourIndex < hours.length; hourIndex += 1) {
    const hourStart = Date.parse(hours[hourIndex].intervalStart);
    for (let blockIndex = 0; blockIndex < 4; blockIndex += 1) {
      const start = hourStart + blockIndex * QUARTER_HOUR_MS;
      const hour = localHourDecimal(start);
      const morning = circularPeak(hour, 9, 2.4);
      const evening = circularPeak(hour, 19, 2.7);
      const demand = 0.35 * morning + 0.65 * evening;
      const renewableAvailability = totalCapacityMW > 0 ? generationByHour[hourIndex] / totalCapacityMW : 0;
      const peak = hour >= 17 && hour < 22 ? 1 : 0;
      const scarcity = Math.max(0, demand - renewableAvailability - 0.25);
      const wave = Math.sin((hourIndex * 4 + blockIndex) * 1.618 + scenario.phase);
      const multiplier = 1
        + scenario.demandAmplitude * demand
        - scenario.renewableInfluence * renewableAvailability
        + scenario.peakPremium * peak
        + scenario.scarcityPremium * scarcity
        + scenario.volatility * wave;
      const price = scenario.basePriceINRPerMWh * multiplier + configuredEventAdder(scenario.events, hourIndex);
      if (!Number.isFinite(price)) throw new TypeError('Market simulation produced a non-finite price');
      const pricePaisePerMWh = Math.round(price * 100);
      nativeIntervals.push({
        intervalStart: new Date(start).toISOString(), intervalEnd: new Date(start + QUARTER_HOUR_MS).toISOString(),
        deliveryStartUtc: new Date(start).toISOString(), deliveryEndUtc: new Date(start + QUARTER_HOUR_MS).toISOString(),
        priceINRPerMWh: pricePaisePerMWh / 100, pricePaisePerMWh, sourceType: SOURCE_TYPE,
        scenarioId, scenarioVersion, hourIndex, blockIndex,
      });
    }
  }
  return nativeIntervals;
}

function persistSimulation({ workflowId, configurationVersion, scenarioId, scenarioVersion, scenario, planningIntervals, nativeIntervals }) {
  const definitionId = marketDefinitionId(REFERENCE_MARKET_DEFINITION);
  const now = new Date().toISOString();
  const runId = createIdentifier('market-simulation');
  const summary = {
    minimumPriceINRPerMWh: Math.min(...nativeIntervals.map(item => item.priceINRPerMWh)),
    maximumPriceINRPerMWh: Math.max(...nativeIntervals.map(item => item.priceINRPerMWh)),
    averagePriceINRPerMWh: nativeIntervals.reduce((sum, item) => sum + item.priceINRPerMWh, 0) / nativeIntervals.length,
  };
  transaction(db => {
    db.prepare(`INSERT OR IGNORE INTO market_definitions
      (market_definition_id, market_id, definition_version, display_name, market_type, reference_pricing_zone,
       currency, price_unit, native_interval_minutes, market_timezone, source_mode, data_provenance_json,
       congestion_limitations, configuration_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      definitionId, REFERENCE_MARKET_DEFINITION.marketId, REFERENCE_MARKET_DEFINITION.definitionVersion,
      REFERENCE_MARKET_DEFINITION.displayName, REFERENCE_MARKET_DEFINITION.marketType,
      REFERENCE_MARKET_DEFINITION.referencePricingZone, 'INR', 'INR_PER_MWH', 15, 'Asia/Kolkata',
      'UNAVAILABLE', json(REFERENCE_MARKET_DEFINITION.dataProvenance), REFERENCE_MARKET_DEFINITION.congestionLimitations,
      configurationVersion, now,
    );
    const existing = db.prepare('SELECT configuration_json FROM synthetic_market_scenario_definitions WHERE scenario_id=? AND scenario_version=?').get(scenarioId, scenarioVersion);
    if (existing && stableJson(JSON.parse(existing.configuration_json)) !== stableJson(scenario)) {
      const error = new Error(`Scenario ${scenarioId} version ${scenarioVersion} already has different configuration`);
      error.code = 'SCENARIO_VERSION_CONFLICT';
      throw error;
    }
    db.prepare(`INSERT OR IGNORE INTO synthetic_market_scenario_definitions
      (scenario_id, scenario_version, market_definition_id, status, source_type, configuration_json, configuration_version, created_at, created_by)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, 'EXPLICIT_DEMO_CONFIGURATION')`)
      .run(scenarioId, scenarioVersion, definitionId, SOURCE_TYPE, json(scenario), configurationVersion, now);
    const insertPrice = db.prepare(`INSERT OR IGNORE INTO market_price_intervals
      (price_interval_id, market_definition_id, market_id, scenario_id, scenario_version, market_product, pricing_area,
       delivery_start_utc, delivery_end_utc, price_paise_per_mwh, currency, price_unit, source_type, original_source,
       retrieval_timestamp, data_quality_status, configuration_version, created_at)
      VALUES (?, ?, ?, ?, ?, 'FICTIONAL_SHARED_REFERENCE', 'SHARED_PORTFOLIO_REFERENCE_PRICE', ?, ?, ?, 'INR', 'INR_PER_MWH', ?, ?, ?, 'COMPLETE', ?, ?)`);
    for (const interval of nativeIntervals) insertPrice.run(
      createIdentifier('market-price'), definitionId, REFERENCE_MARKET_DEFINITION.marketId, scenarioId, scenarioVersion,
      interval.intervalStart, interval.intervalEnd, interval.pricePaisePerMWh, SOURCE_TYPE,
      `${scenarioId}:v${scenarioVersion}`, now, configurationVersion, now,
    );
    db.prepare(`INSERT INTO market_simulation_runs
      (simulation_run_id, workflow_id, market_id, scenario_id, scenario_version, configuration_version, status,
       planning_start_utc, planning_end_utc, interval_count, input_snapshot_json, summary_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?)`).run(
      runId, workflowId, REFERENCE_MARKET_DEFINITION.marketId, scenarioId, scenarioVersion, configurationVersion,
      planningIntervals[0].intervalStart, planningIntervals.at(-1).intervalEnd, nativeIntervals.length,
      json({ scenario, planningIntervals }), json(summary), now,
    );
  });
  return { runId, summary };
}

function unavailableMarket(status, missing, planningIntervals = []) {
  return {
    agent: 'NUMERICAL_MARKET', agentRunId: createId('market-run'), status, mode: 'UNAVAILABLE', source: 'UNAVAILABLE',
    sourceType: 'UNAVAILABLE', generatedAt: new Date().toISOString(), priceUnit: 'INR_PER_MWH', nativeIntervals: [], hourlyIntervals: [],
    forecasts: [], currentPricePerMWh: null, uncertainty: null, intelligence: null, planningIntervals, missing,
    historicalReadiness: marketDataReadiness(),
  };
}

function createMarketSimulationService({ configurationProvider = getActiveConfiguration } = {}) {
  function getOutlook({ planningIntervals, generationOutlooks = [], workflowId = null } = {}) {
    const active = configurationProvider();
    const market = active.configuration.marketSimulation;
    const scenarioId = market?.activeScenarioId?.value;
    const scenarioVersion = market?.scenarioVersion?.value;
    if (!scenarioId || !scenarioVersion) return unavailableMarket('INCOMPLETE_SIMULATION_CONFIG', ['marketSimulation.activeScenarioId', 'marketSimulation.scenarioVersion'], planningIntervals || []);
    const scenario = market.scenarios?.[scenarioId];
    if (!scenario) return unavailableMarket('INCOMPLETE_SIMULATION_CONFIG', [`marketSimulation.scenarios.${scenarioId}`], planningIntervals || []);
    const execution = startComponent({ workflowId, component: 'NUMERICAL_MARKET_SIMULATION', sourceType: SOURCE_TYPE, modelName: 'DETERMINISTIC_MARKET_SIMULATOR', modelVersion: MODEL_VERSION, input: { scenarioId, scenarioVersion, configurationVersion: active.configVersion } });
    try {
      const alignedPlanning = validatePlanningIntervals(planningIntervals);
      const nativeIntervals = generateDeterministicPrices({ planningIntervals: alignedPlanning, scenario, generationOutlooks, scenarioId, scenarioVersion });
      const hourlyIntervals = aggregateMarketIntervalsToHours({ planningIntervals: alignedPlanning, priceIntervals: nativeIntervals });
      const persisted = persistSimulation({ workflowId, configurationVersion: active.configVersion, scenarioId, scenarioVersion, scenario, planningIntervals: alignedPlanning, nativeIntervals });
      const horizons = [1, 6, 24, 48, 72].map(hour => ({ horizon: `${hour}h`, validAt: hourlyIntervals[hour - 1].intervalEnd, predictedPricePerMWh: hourlyIntervals[hour - 1].priceINRPerMWh, confidencePct: null }));
      const prices = hourlyIntervals.map(item => item.priceINRPerMWh);
      const maxPrice = Math.max(...prices);
      const peakIndex = prices.indexOf(maxPrice);
      const response = {
        agent: 'NUMERICAL_MARKET', agentRunId: createId('market-run'), marketSimulationRunId: persisted.runId,
        status: 'READY', mode: 'DEMO_SIMULATION', marketId: REFERENCE_MARKET_DEFINITION.marketId,
        scenarioId, scenarioVersion, scenarioName: scenario.displayName, modelVersion: MODEL_VERSION,
        configurationVersion: active.configVersion, generatedAt: new Date().toISOString(), source: SOURCE_TYPE,
        sourceType: SOURCE_TYPE, priceUnit: 'INR_PER_MWH', nativeIntervalMinutes: 15,
        currentPricePerMWh: hourlyIntervals[0].priceINRPerMWh, currentPriceSemantics: 'FIRST_FUTURE_PLANNING_INTERVAL',
        nativeIntervals, hourlyIntervals, forecasts: horizons, uncertainty: null,
        expectedPeakPricePerMWh: maxPrice, expectedPeakAt: hourlyIntervals[peakIndex].intervalStart,
        summary: persisted.summary, intelligence: null, historicalReadiness: marketDataReadiness(),
      };
      completeComponent(execution, { status: 'COMPLETED', sourceType: SOURCE_TYPE, output: { scenarioId, nativeIntervals: 288, hourlyIntervals: 72, runId: persisted.runId } });
      recordAgentRun({ agent: 'NUMERICAL_MARKET', agentRunId: response.agentRunId, status: 'READY', source: SOURCE_TYPE, generatedAt: response.generatedAt });
      recordActivity({ type: 'MARKET_SIMULATION_COMPLETED', message: `${scenario.displayName} produced 288 configured fictional price blocks.` });
      return response;
    } catch (error) {
      failComponent(execution, error);
      throw error;
    }
  }
  return { getOutlook };
}

module.exports = { SOURCE_TYPE, MODEL_VERSION, validatePlanningIntervals, generateDeterministicPrices, createMarketSimulationService };

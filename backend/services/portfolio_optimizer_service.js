const solver = require('javascript-lp-solver');
const crypto = require('node:crypto');
const { getDatabase, transaction, json } = require('./database_service');
const { getActiveConfiguration, missingEconomicAssumptions } = require('./configuration_service');
const { startComponent, completeComponent, failComponent, createIdentifier } = require('./workflow_service');
const { recordAgentRun, recordActivity } = require('./runtime_store');

const SOLVER_NAME = 'javascript-lp-solver';
const MODEL_VERSION = 'fleet-milp-v1';
const STRATEGIES = new Set(['BALANCED', 'PROFIT_FOCUS', 'CONSERVATIVE', 'GREEN_FOCUS']);
const EPSILON = 1e-5;

const key = (kind, farmIndex, hour) => `${kind}_${farmIndex}_${hour}`;
const value = (solution, name) => Math.max(0, Number(solution[name] || 0));
const rounded = number => Number(number.toFixed(4));
const availableGeneration = (farm, outlook, hour) => Number(outlook.intervals[hour].predictedGenerationMW) * Number(farm.outputLimitPct ?? 100) / 100;

function addCoefficient(variables, variable, constraint, coefficient) {
  variables[variable] ||= { objective: 0 };
  variables[variable][constraint] = (variables[variable][constraint] || 0) + coefficient;
}

function validateInputs({ farms, generationOutlooks, marketOutlook }) {
  if (!Array.isArray(farms) || !farms.length) throw new TypeError('farms must be a non-empty array');
  if (!Array.isArray(generationOutlooks) || generationOutlooks.length !== farms.length) throw new TypeError('One generation outlook is required per farm');
  if (!marketOutlook || marketOutlook.status !== 'READY' || !Array.isArray(marketOutlook.hourlyIntervals) || marketOutlook.hourlyIntervals.length !== 72) throw new TypeError('A ready 72-hour numerical market outlook is required');
  for (let farmIndex = 0; farmIndex < farms.length; farmIndex += 1) {
    const outlook = generationOutlooks[farmIndex];
    if (outlook.farmId !== farms[farmIndex].farmId || outlook.status !== 'READY' || outlook.intervals?.length !== 72) throw new TypeError(`A ready 72-hour generation outlook is required for ${farms[farmIndex].farmId}`);
    for (let hour = 0; hour < 72; hour += 1) {
      const generation = outlook.intervals[hour];
      const price = marketOutlook.hourlyIntervals[hour];
      if (generation.intervalStart !== price.intervalStart || generation.intervalEnd !== price.intervalEnd) throw new TypeError(`Generation and market intervals differ at hour ${hour + 1}`);
    }
  }
}

function buildModel({ farms, generationOutlooks, marketOutlook, configuration, strategyName }) {
  const preset = configuration.optimization.strategyPresets.value[strategyName];
  if (!preset) throw new TypeError(`Strategy ${strategyName} is not configured`);
  const constraints = {};
  const variables = {};
  const binaries = {};
  const chargingEfficiency = configuration.battery.chargingEfficiency.value;
  const dischargingEfficiency = configuration.battery.dischargingEfficiency.value;
  const degradation = configuration.battery.degradationCostPerMWh.value;
  const fee = configuration.economics.marketTransactionFeePerMWh.value;
  const importTariff = configuration.economics.importTariffPerMWh.value;
  const exportTariff = configuration.economics.exportTariffPerMWh.value;
  const reserveBufferPct = configuration.optimization.riskAssumptions.value.reserveBufferPct;
  const averagePrice = marketOutlook.hourlyIntervals.reduce((sum, item) => sum + item.priceINRPerMWh, 0) / 72;

  for (let hour = 0; hour < 72; hour += 1) {
    const sharedExport = `shared_export_${hour}`;
    const sharedImport = `shared_import_${hour}`;
    constraints[sharedExport] = { max: configuration.sharedFleetLimits.gridExportCapacityMW.value };
    constraints[sharedImport] = { max: configuration.sharedFleetLimits.gridImportCapacityMW.value };
    for (let farmIndex = 0; farmIndex < farms.length; farmIndex += 1) {
      const farm = farms[farmIndex];
      const generation = availableGeneration(farm, generationOutlooks[farmIndex], hour);
      const price = marketOutlook.hourlyIntervals[hour].priceINRPerMWh;
      const effectiveCapacity = farm.batteryCapacityMWh * (farm.batterySohPct ?? 100) / 100;
      const minimumSoc = effectiveCapacity * Math.min(100, farm.reservePct + reserveBufferPct) / 100;
      const maximumSoc = effectiveCapacity * (farm.batterySafeChargePct ?? 95) / 100;
      const powerLimit = farm.batteryMaxPowerMW;
      const chargeLimit = ['IDLE', 'DISCHARGE'].includes(farm.batteryMode) ? 0 : powerLimit;
      const dischargeLimit = ['IDLE', 'CHARGE'].includes(farm.batteryMode) ? 0 : powerLimit;
      const exportLimit = Math.min(farm.gridExportLimitMW, farm.connectionExportCapacityMW ?? farm.gridExportLimitMW);
      const importLimit = farm.gridImportAllowed ? Math.min(farm.gridImportLimitMW, farm.connectionImportCapacityMW ?? farm.gridImportLimitMW) : 0;
      const generationBalance = `generation_${farmIndex}_${hour}`;
      const socBalance = `soc_balance_${farmIndex}_${hour}`;
      const exportConstraint = `farm_export_${farmIndex}_${hour}`;
      const importConstraint = `farm_import_${farmIndex}_${hour}`;
      const chargePower = `charge_power_${farmIndex}_${hour}`;
      const dischargePower = `discharge_power_${farmIndex}_${hour}`;
      const exclusive = `exclusive_${farmIndex}_${hour}`;
      constraints[generationBalance] = { equal: generation };
      constraints[socBalance] = { equal: hour === 0 ? effectiveCapacity * farm.batterySocPct / 100 : 0 };
      constraints[exportConstraint] = { max: exportLimit };
      constraints[importConstraint] = { max: importLimit };
      constraints[chargePower] = { max: 0 };
      constraints[dischargePower] = { max: dischargeLimit };
      constraints[exclusive] = { max: 1 };

      const directExport = key('export', farmIndex, hour);
      const generationCharge = key('gencharge', farmIndex, hour);
      const curtail = key('curtail', farmIndex, hour);
      const discharge = key('discharge', farmIndex, hour);
      const gridImport = key('import', farmIndex, hour);
      const soc = key('soc', farmIndex, hour);
      const chargeMode = key('charge_mode', farmIndex, hour);
      binaries[chargeMode] = 1;

      variables[directExport] = { objective: preset.economicWeight * (price - fee - exportTariff) };
      variables[generationCharge] = { objective: -preset.cyclingPenaltyINRPerMWh - degradation / 2 };
      variables[curtail] = { objective: -preset.curtailmentPenaltyINRPerMWh };
      variables[discharge] = { objective: preset.economicWeight * (price - fee - exportTariff) - preset.cyclingPenaltyINRPerMWh - degradation / 2 };
      variables[gridImport] = { objective: -preset.economicWeight * (price + fee + importTariff) - preset.cyclingPenaltyINRPerMWh - degradation / 2 };
      variables[soc] = { objective: hour === 71 ? averagePrice * preset.terminalSocValueFactor : 0 };
      variables[chargeMode] = { objective: 0 };

      for (const variable of [directExport, generationCharge, curtail]) addCoefficient(variables, variable, generationBalance, 1);
      addCoefficient(variables, soc, socBalance, 1);
      addCoefficient(variables, generationCharge, socBalance, -chargingEfficiency);
      addCoefficient(variables, gridImport, socBalance, -chargingEfficiency);
      addCoefficient(variables, discharge, socBalance, 1 / dischargingEfficiency);
      if (hour > 0) addCoefficient(variables, key('soc', farmIndex, hour - 1), socBalance, -1);
      addCoefficient(variables, directExport, exportConstraint, 1);
      addCoefficient(variables, discharge, exportConstraint, 1);
      addCoefficient(variables, gridImport, importConstraint, 1);
      addCoefficient(variables, generationCharge, chargePower, 1);
      addCoefficient(variables, gridImport, chargePower, 1);
      addCoefficient(variables, chargeMode, chargePower, -chargeLimit);
      addCoefficient(variables, discharge, dischargePower, 1);
      addCoefficient(variables, chargeMode, dischargePower, dischargeLimit);
      addCoefficient(variables, chargeMode, exclusive, 1);
      addCoefficient(variables, directExport, sharedExport, 1);
      addCoefficient(variables, discharge, sharedExport, 1);
      addCoefficient(variables, gridImport, sharedImport, 1);
      constraints[`soc_min_${farmIndex}_${hour}`] = { min: minimumSoc };
      constraints[`soc_max_${farmIndex}_${hour}`] = { max: maximumSoc };
      addCoefficient(variables, soc, `soc_min_${farmIndex}_${hour}`, 1);
      addCoefficient(variables, soc, `soc_max_${farmIndex}_${hour}`, 1);
    }
  }
  return { optimize: 'objective', opType: 'max', constraints, variables, binaries, options: { tolerance: 1e-8 } };
}

function allocationFromSolution({ solution, farm, farmIndex, hour, generationOutlook, marketOutlook, configuration }) {
  const directExportMWh = value(solution, key('export', farmIndex, hour));
  const batteryChargeMWh = value(solution, key('gencharge', farmIndex, hour));
  const curtailmentMWh = value(solution, key('curtail', farmIndex, hour));
  const batteryDischargeMWh = value(solution, key('discharge', farmIndex, hour));
  const gridImportMWh = value(solution, key('import', farmIndex, hour));
  const socEndMWh = value(solution, key('soc', farmIndex, hour));
  const effectiveCapacity = farm.batteryCapacityMWh * (farm.batterySohPct ?? 100) / 100;
  const socStartMWh = hour === 0 ? effectiveCapacity * farm.batterySocPct / 100 : value(solution, key('soc', farmIndex, hour - 1));
  const interval = generationOutlook.intervals[hour];
  const expectedGenerationMWh = availableGeneration(farm, generationOutlook, hour);
  const price = marketOutlook.hourlyIntervals[hour].priceINRPerMWh;
  const exportEnergy = directExportMWh + batteryDischargeMWh;
  const chargeThroughput = batteryChargeMWh + gridImportMWh;
  const grossSaleRevenue = exportEnergy * price;
  const purchaseCost = gridImportMWh * price;
  const transactionFees = (exportEnergy + gridImportMWh) * configuration.economics.marketTransactionFeePerMWh.value;
  const degradationCost = (chargeThroughput + batteryDischargeMWh) * configuration.battery.degradationCostPerMWh.value;
  const exportTariffCost = exportEnergy * configuration.economics.exportTariffPerMWh.value;
  const importTariffCost = gridImportMWh * configuration.economics.importTariffPerMWh.value;
  return {
    farmId: farm.farmId, hourIndex: hour, intervalStart: interval.intervalStart, intervalEnd: interval.intervalEnd,
    expectedGenerationMWh: rounded(expectedGenerationMWh), directExportMWh: rounded(directExportMWh),
    energyStoredMWh: rounded(batteryChargeMWh + gridImportMWh), renewableStoredMWh: rounded(batteryChargeMWh),
    gridImportMWh: rounded(gridImportMWh), batteryDischargeMWh: rounded(batteryDischargeMWh), curtailmentMWh: rounded(curtailmentMWh),
    socStartMWh: rounded(socStartMWh), socEndMWh: rounded(socEndMWh), projectedSocPct: rounded(socEndMWh / effectiveCapacity * 100),
    priceINRPerMWh: price, grossSaleRevenueINR: rounded(grossSaleRevenue), purchaseCostINR: rounded(purchaseCost),
    transactionFeesINR: rounded(transactionFees), degradationCostINR: rounded(degradationCost), exportTariffCostINR: rounded(exportTariffCost),
    importTariffCostINR: rounded(importTariffCost), projectedNetValueINR: rounded(grossSaleRevenue - purchaseCost - transactionFees - degradationCost - exportTariffCost - importTariffCost),
  };
}

function validatePortfolioPlan(plan, farms, configuration) {
  const violations = [];
  for (let hour = 0; hour < 72; hour += 1) {
    const rows = plan.allocations.filter(row => row.hourIndex === hour);
    const fleetExport = rows.reduce((sum, row) => sum + row.directExportMWh + row.batteryDischargeMWh, 0);
    const fleetImport = rows.reduce((sum, row) => sum + row.gridImportMWh, 0);
    if (fleetExport > configuration.sharedFleetLimits.gridExportCapacityMW.value + EPSILON) violations.push(`Shared export exceeded at hour ${hour}`);
    if (fleetImport > configuration.sharedFleetLimits.gridImportCapacityMW.value + EPSILON) violations.push(`Shared import exceeded at hour ${hour}`);
    rows.forEach(row => {
      const farm = farms.find(item => item.farmId === row.farmId);
      const balance = row.directExportMWh + row.renewableStoredMWh + row.curtailmentMWh;
      if (Math.abs(balance - row.expectedGenerationMWh) > 0.02) violations.push(`Generation balance failed for ${row.farmId} hour ${hour}`);
      if (row.energyStoredMWh > EPSILON && row.batteryDischargeMWh > EPSILON) violations.push(`Simultaneous charge/discharge for ${row.farmId} hour ${hour}`);
      if (row.directExportMWh + row.batteryDischargeMWh > farm.gridExportLimitMW + EPSILON) violations.push(`Farm export limit exceeded for ${row.farmId} hour ${hour}`);
    });
  }
  return { valid: violations.length === 0, violations };
}

function summarize(plan) {
  const total = field => rounded(plan.allocations.reduce((sum, row) => sum + row[field], 0));
  const perFarm = Object.fromEntries([...new Set(plan.allocations.map(row => row.farmId))].map(farmId => {
    const rows = plan.allocations.filter(row => row.farmId === farmId);
    const sum = field => rounded(rows.reduce((totalValue, row) => totalValue + row[field], 0));
    return [farmId, { exportedMWh: sum('directExportMWh') + sum('batteryDischargeMWh'), storedMWh: sum('energyStoredMWh'), importedMWh: sum('gridImportMWh'), dischargedMWh: sum('batteryDischargeMWh'), curtailedMWh: sum('curtailmentMWh'), netValueINR: sum('projectedNetValueINR') }];
  }));
  const generation = total('expectedGenerationMWh');
  const curtailed = total('curtailmentMWh');
  return {
    expectedGenerationMWh: generation, exportedMWh: total('directExportMWh') + total('batteryDischargeMWh'), storedMWh: total('energyStoredMWh'),
    importedMWh: total('gridImportMWh'), batteryDischargeMWh: total('batteryDischargeMWh'), curtailedMWh: curtailed,
    projectedGrossRevenueINR: total('grossSaleRevenueINR'), projectedPurchaseCostINR: total('purchaseCostINR'),
    projectedFeesINR: total('transactionFeesINR'), projectedDegradationCostINR: total('degradationCostINR'), projectedNetValueINR: total('projectedNetValueINR'),
    renewableUtilizationPct: generation ? rounded((generation - curtailed) / generation * 100) : 100, perFarm,
  };
}

function persistPlan(plan, validation, inputs) {
  transaction(db => {
    db.prepare(`INSERT INTO portfolio_optimizer_runs
      (optimizer_run_id, workflow_id, scenario_id, strategy_name, strategy_version, solver_name, solver_status,
       configuration_version, input_snapshot_id, input_json, result_json, validation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      plan.optimizerRunId, plan.workflowId, plan.scenarioId, plan.strategyName, plan.strategyVersion, SOLVER_NAME, plan.solverStatus,
      plan.configurationVersion, plan.inputSnapshotId, json(inputs), json(plan), json(validation), plan.generatedAt,
    );
    const insert = db.prepare(`INSERT INTO portfolio_plan_allocations
      (allocation_id, optimizer_run_id, farm_id, hour_index, interval_start_utc, interval_end_utc, generation_mwh,
       direct_export_mwh, battery_charge_mwh, battery_discharge_mwh, grid_import_mwh, curtailment_mwh,
       soc_start_mwh, soc_end_mwh, price_inr_per_mwh, projected_net_value_inr, source_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USER_CONFIGURED_SIMULATION', ?)`);
    for (const row of plan.allocations) insert.run(createIdentifier('plan-allocation'), plan.optimizerRunId, row.farmId, row.hourIndex,
      row.intervalStart, row.intervalEnd, row.expectedGenerationMWh, row.directExportMWh, row.energyStoredMWh,
      row.batteryDischargeMWh, row.gridImportMWh, row.curtailmentMWh, row.socStartMWh, row.socEndMWh,
      row.priceINRPerMWh, row.projectedNetValueINR, plan.generatedAt);
  });
}

function optimizePortfolio({ farms, generationOutlooks, marketOutlook, strategyName = 'BALANCED', workflowId = null, configurationProvider = getActiveConfiguration }) {
  const active = configurationProvider();
  const missing = missingEconomicAssumptions(active.configuration);
  if (missing.length) return { agent: 'FLEET_OPTIMIZER', status: 'INCOMPLETE_ASSUMPTIONS', missing, strategyName, allocations: [], generatedAt: new Date().toISOString(), configurationVersion: active.configVersion };
  if (!STRATEGIES.has(strategyName)) throw new TypeError(`strategyName must be one of ${[...STRATEGIES].join(', ')}`);
  validateInputs({ farms, generationOutlooks, marketOutlook });
  const execution = startComponent({ workflowId, component: 'FLEET_OPTIMIZER', sourceType: 'USER_CONFIGURED_SIMULATION', modelName: 'PORTFOLIO_MILP', modelVersion: MODEL_VERSION, input: { strategyName, farmCount: farms.length, horizonHours: 72, marketRunId: marketOutlook.marketSimulationRunId } });
  try {
    const model = buildModel({ farms, generationOutlooks, marketOutlook, configuration: active.configuration, strategyName });
    const solution = solver.Solve(model);
    if (!solution.feasible || !solution.bounded) {
      const result = { agent: 'FLEET_OPTIMIZER', status: solution.feasible ? 'UNBOUNDED' : 'INFEASIBLE', solverStatus: solution.feasible ? 'UNBOUNDED' : 'INFEASIBLE', strategyName, allocations: [], generatedAt: new Date().toISOString(), configurationVersion: active.configVersion };
      completeComponent(execution, { status: result.status, sourceType: 'USER_CONFIGURED_SIMULATION', output: result });
      return result;
    }
    const allocations = [];
    for (let farmIndex = 0; farmIndex < farms.length; farmIndex += 1) for (let hour = 0; hour < 72; hour += 1) allocations.push(allocationFromSolution({ solution, farm: farms[farmIndex], farmIndex, hour, generationOutlook: generationOutlooks[farmIndex], marketOutlook, configuration: active.configuration }));
    const inputSnapshot = { farmState: farms.map(farm => ({ farmId: farm.farmId, batterySocPct: farm.batterySocPct, reservePct: farm.reservePct, gridExportLimitMW: farm.gridExportLimitMW, gridImportLimitMW: farm.gridImportLimitMW, outputLimitPct: farm.outputLimitPct, batteryMode: farm.batteryMode })), generationRunIds: generationOutlooks.map(item => item.agentRunId), marketRunId: marketOutlook.marketSimulationRunId, configurationVersion: active.configVersion };
    const inputSnapshotId = crypto.createHash('sha256').update(JSON.stringify(inputSnapshot)).digest('hex');
    const preset = active.configuration.optimization.strategyPresets.value[strategyName];
    const plan = { agent: 'FLEET_OPTIMIZER', optimizerRunId: createIdentifier('portfolio-optimizer'), workflowId, scenarioId: marketOutlook.scenarioId, strategyName, strategyVersion: preset.version, status: 'OPTIMAL', solverStatus: 'OPTIMAL', solverName: SOLVER_NAME, modelVersion: MODEL_VERSION, generatedAt: new Date().toISOString(), configurationVersion: active.configVersion, inputSnapshotId, objectiveValueINR: rounded(solution.result), allocations, warnings: ['All monetary results are fictional simulation projections.'] };
    plan.totals = summarize(plan);
    const validation = validatePortfolioPlan(plan, farms, active.configuration);
    plan.validation = validation;
    if (!validation.valid) throw Object.assign(new Error(`Optimizer solution failed validation: ${validation.violations.join('; ')}`), { code: 'INVALID_SOLVER_RESULT' });
    persistPlan(plan, validation, inputSnapshot);
    completeComponent(execution, { status: 'COMPLETED', sourceType: 'USER_CONFIGURED_SIMULATION', output: { optimizerRunId: plan.optimizerRunId, strategyName, solverStatus: plan.solverStatus, totals: plan.totals } });
    recordAgentRun({ agent: 'FLEET_OPTIMIZER', agentRunId: plan.optimizerRunId, status: 'COMPLETED', source: 'MILP', generatedAt: plan.generatedAt });
    recordActivity({ type: 'FLEET_OPTIMIZATION_COMPLETED', message: `${strategyName} portfolio MILP completed with independently validated energy balances.` });
    return plan;
  } catch (error) {
    failComponent(execution, error);
    throw error;
  }
}

module.exports = { SOLVER_NAME, MODEL_VERSION, STRATEGIES, buildModel, validatePortfolioPlan, optimizePortfolio };

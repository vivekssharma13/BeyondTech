const { getDatabase, transaction, json } = require('./database_service');
const { createIdentifier, sanitize } = require('./workflow_service');
const { getPersistedFarmState } = require('./simulation_state_service');

function saveOptimizerScenario({ workflowId = null, runId, farmId, status, input, result }) {
  const scenarioId = createIdentifier('scenario');
  getDatabase().prepare(`INSERT INTO optimizer_scenarios
    (scenario_id, workflow_id, run_id, farm_id, status, strategy_name, input_summary_json, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'LEGACY_FEASIBILITY', ?, ?, ?)`)
    .run(scenarioId, workflowId, runId, farmId, status, json(sanitize(input)), json(sanitize(result)), new Date().toISOString());
  return scenarioId;
}

function saveDecisionProposal(decision) {
  const now = decision.generatedAt || new Date().toISOString();
  const storedProposal = sanitize(decision);
  if (decision.plan) storedProposal.plan = decision.plan;
  if (decision.firstHourAllocations) storedProposal.firstHourAllocations = decision.firstHourAllocations;
  transaction(db => {
    db.prepare(`INSERT OR REPLACE INTO decision_proposals
      (decision_id, workflow_id, run_id, farm_id, status, action, quantity_mw, source_type, proposal_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(decision.decisionId, decision.workflowId || null, decision.agentRunId, decision.farmId, decision.executionStatus, decision.decision, decision.quantityMW, decision.sourceType || 'USER_CONFIGURED_SIMULATION', json(storedProposal), now, now);
    if (Array.isArray(decision.firstHourAllocations)) {
      const insertAllocation = db.prepare(`INSERT INTO planned_energy_allocations
        (allocation_id, decision_id, farm_id, action, power_mw, interval_start, interval_end, source_type, created_at)
        VALUES (?, ?, ?, 'PORTFOLIO_FIRST_HOUR', ?, ?, ?, ?, ?)`);
      for (const allocation of decision.firstHourAllocations) insertAllocation.run(
        createIdentifier('planned-allocation'), decision.decisionId, allocation.farmId,
        allocation.directExportMWh + allocation.batteryDischargeMWh - allocation.gridImportMWh,
        allocation.intervalStart, allocation.intervalEnd, decision.sourceType || 'USER_CONFIGURED_SIMULATION', now,
      );
      db.prepare('UPDATE portfolio_plan_allocations SET decision_id=? WHERE optimizer_run_id=?').run(decision.decisionId, decision.optimizerRunId);
    } else {
      db.prepare(`INSERT INTO planned_energy_allocations
        (allocation_id, decision_id, farm_id, action, power_mw, interval_start, interval_end, source_type, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
        .run(createIdentifier('planned-allocation'), decision.decisionId, decision.farmId, decision.decision, decision.quantityMW, decision.sourceType || 'USER_CONFIGURED_SIMULATION', now);
    }
    db.prepare(`INSERT INTO decision_events
      (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
      VALUES (?, ?, 'PROPOSED', 'SYSTEM', ?, ?)`)
      .run(createIdentifier('decision-event'), decision.decisionId, now, json({ workflowId: decision.workflowId || null }));
  });
}

function persistPortfolioDecisionAction({ decision, action, farms, configurationVersion, configuration, now = Date.now() }) {
  const createdAt = new Date(now).toISOString();
  return transaction(db => {
    const current = db.prepare('SELECT status FROM decision_proposals WHERE decision_id=?').get(decision.decisionId);
    if (!current) throw new Error(`Decision ${decision.decisionId} is not persisted`);
    if (current.status !== 'PENDING') {
      const error = new Error(`Decision ${decision.decisionId} is already ${current.status}`);
      error.code = 'DECISION_ALREADY_APPLIED';
      throw error;
    }
    if (action === 'DISMISS') {
      db.prepare("UPDATE decision_proposals SET status='DISMISSED', updated_at=? WHERE decision_id=?").run(createdAt, decision.decisionId);
      db.prepare(`INSERT INTO decision_events (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
        VALUES (?, ?, 'DISMISSED', 'USER', ?, '{}')`).run(createIdentifier('decision-event'), decision.decisionId, createdAt);
      return { status: 'DISMISSED', decisionId: decision.decisionId, appliedAt: null, farms: [], financialTotals: null };
    }
    if (configurationVersion !== decision.configurationVersion) {
      db.prepare("UPDATE decision_proposals SET status='REJECTED', updated_at=? WHERE decision_id=?").run(createdAt, decision.decisionId);
      db.prepare(`INSERT INTO decision_events (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
        VALUES (?, ?, 'REJECTED_STALE_CONFIGURATION', 'SYSTEM', ?, ?)`).run(createIdentifier('decision-event'), decision.decisionId, createdAt, json({ expectedConfigurationVersion: decision.configurationVersion, actualConfigurationVersion: configurationVersion }));
      return { status: 'REJECTED', decisionId: decision.decisionId, reason: 'STALE_CONFIGURATION', appliedAt: null, farms: [], financialTotals: null };
    }
    const allocations = decision.firstHourAllocations || [];
    if (!allocations.length) throw new Error('Portfolio decision has no first-hour allocations');
    if (now >= Date.parse(allocations[0].intervalEnd)) {
      db.prepare("UPDATE decision_proposals SET status='EXPIRED', updated_at=? WHERE decision_id=?").run(createdAt, decision.decisionId);
      db.prepare(`INSERT INTO decision_events (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
        VALUES (?, ?, 'EXPIRED', 'SYSTEM', ?, ?)`).run(createIdentifier('decision-event'), decision.decisionId, createdAt, json({ intervalEnd: allocations[0].intervalEnd }));
      return { status: 'EXPIRED', decisionId: decision.decisionId, reason: 'FIRST_INTERVAL_EXPIRED', appliedAt: null, farms: [], financialTotals: null };
    }
    const preflight = allocations.map(allocation => {
      const farm = farms.find(item => item.farmId === allocation.farmId);
      const persisted = farm ? getPersistedFarmState(allocation.farmId, db) : null;
      const exportMWh = allocation.directExportMWh + allocation.batteryDischargeMWh;
      const valid = farm && persisted && persisted.stateVersion === decision.inputStateVersions[allocation.farmId]
        && exportMWh <= persisted.state.gridExportLimitMW + 1e-6
        && allocation.gridImportMWh <= persisted.state.gridImportLimitMW + 1e-6;
      return { allocation, farm, persisted, exportMWh, valid };
    });
    const rejected = preflight.find(item => !item.valid);
    if (rejected) {
      db.prepare("UPDATE decision_proposals SET status='REJECTED', updated_at=? WHERE decision_id=?").run(createdAt, decision.decisionId);
      db.prepare(`INSERT INTO decision_events (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
        VALUES (?, ?, 'REJECTED_STALE_STATE', 'SYSTEM', ?, ?)`).run(createIdentifier('decision-event'), decision.decisionId, createdAt, json({ farmId: rejected.allocation.farmId }));
      return { status: 'REJECTED', decisionId: decision.decisionId, reason: 'STALE_OPERATIONAL_STATE', appliedAt: null, farms: [], financialTotals: null };
    }
    const applied = [];
    const financialTotals = { exportedEnergyMWh: 0, importedEnergyMWh: 0, energyStoredMWh: 0, curtailedEnergyMWh: 0, netValueINR: 0 };
    db.prepare("UPDATE decision_proposals SET status='APPROVED', updated_at=? WHERE decision_id=?").run(createdAt, decision.decisionId);
    db.prepare(`INSERT INTO decision_events (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
      VALUES (?, ?, 'APPROVED', 'USER', ?, ?)`).run(createIdentifier('decision-event'), decision.decisionId, createdAt, json({ optimizerRunId: decision.optimizerRunId }));
    for (const { allocation, persisted, exportMWh } of preflight) {
      const before = persisted.state;
      const existingLedgerValue = Number(db.prepare('SELECT COALESCE(SUM(net_value_inr), 0) AS value FROM simulated_financial_ledger WHERE farm_id=?').get(allocation.farmId).value);
      const ledgerNetValueINR = allocation.grossSaleRevenueINR
        - allocation.purchaseCostINR
        - allocation.transactionFeesINR
        - allocation.degradationCostINR
        - allocation.exportTariffCostINR
        - allocation.importTariffCostINR;
      const after = {
        ...before,
        currentExportMW: Number(exportMWh.toFixed(4)),
        currentImportMW: Number(allocation.gridImportMWh.toFixed(4)),
        batteryPowerMW: Number((allocation.batteryDischargeMWh - allocation.energyStoredMWh).toFixed(4)),
        batterySocPct: Number(allocation.projectedSocPct.toFixed(4)),
        revenueToday: Number((existingLedgerValue + ledgerNetValueINR).toFixed(2)),
      };
      const nextVersion = persisted.stateVersion + 1;
      const updated = db.prepare(`UPDATE simulated_farm_state SET state_version=?, state_json=?, source_type='USER_CONFIGURED_SIMULATION', source_ref=?, updated_at=? WHERE farm_id=? AND state_version=?`)
        .run(nextVersion, json(after), `portfolio-decision:${decision.decisionId}`, createdAt, allocation.farmId, persisted.stateVersion);
      if (updated.changes !== 1) {
        const error = new Error(`Operational state changed concurrently for ${allocation.farmId}`);
        error.code = 'STATE_VERSION_CONFLICT';
        throw error;
      }
      db.prepare(`INSERT INTO applied_portfolio_allocations
        (applied_allocation_id, decision_id, optimizer_run_id, farm_id, interval_start_utc, interval_end_utc,
         allocation_json, state_before_json, state_after_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(createIdentifier('applied-portfolio'), decision.decisionId, decision.optimizerRunId, allocation.farmId,
          allocation.intervalStart, allocation.intervalEnd, json(allocation), json(before), json(after), createdAt);
      const exportedEnergyMWh = exportMWh;
      const importedEnergyMWh = allocation.gridImportMWh;
      const batteryThroughputMWh = allocation.energyStoredMWh + allocation.batteryDischargeMWh;
      db.prepare(`INSERT INTO simulated_financial_ledger
        (ledger_entry_id, decision_id, optimizer_run_id, farm_id, delivery_start_utc, delivery_end_utc, applied_at,
         exported_energy_mwh, imported_energy_mwh, battery_throughput_mwh, price_inr_per_mwh,
         gross_sale_revenue_inr, purchase_cost_inr, transaction_fees_inr, degradation_cost_inr,
         export_tariff_cost_inr, import_tariff_cost_inr, net_value_inr, currency, status, source_type,
         configuration_version, calculation_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', 'APPLIED_SIMULATED',
          'USER_CONFIGURED_SIMULATION', ?, ?, ?)`)
        .run(createIdentifier('sim-ledger'), decision.decisionId, decision.optimizerRunId, allocation.farmId,
          allocation.intervalStart, allocation.intervalEnd, createdAt, exportedEnergyMWh, importedEnergyMWh,
          batteryThroughputMWh, allocation.priceINRPerMWh, allocation.grossSaleRevenueINR, allocation.purchaseCostINR,
          allocation.transactionFeesINR, allocation.degradationCostINR, allocation.exportTariffCostINR,
          allocation.importTariffCostINR, ledgerNetValueINR, configurationVersion,
          json({ durationHours: 1, priceUnit: 'INR_PER_MWH', energyUnit: 'MWH', assumptions: { transactionFeePerMWh: configuration.economics.marketTransactionFeePerMWh.value, degradationCostPerMWh: configuration.battery.degradationCostPerMWh.value, exportTariffPerMWh: configuration.economics.exportTariffPerMWh.value, importTariffPerMWh: configuration.economics.importTariffPerMWh.value } }), createdAt);
      applied.push({ farmId: allocation.farmId, before, after, stateVersion: nextVersion, allocation });
      financialTotals.exportedEnergyMWh += exportedEnergyMWh;
      financialTotals.importedEnergyMWh += importedEnergyMWh;
      financialTotals.energyStoredMWh += allocation.energyStoredMWh;
      financialTotals.curtailedEnergyMWh += allocation.curtailmentMWh;
      financialTotals.netValueINR += ledgerNetValueINR;
    }
    db.prepare("UPDATE decision_proposals SET status='APPLIED_SIMULATED', updated_at=? WHERE decision_id=?").run(createdAt, decision.decisionId);
    db.prepare(`INSERT INTO decision_events (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
      VALUES (?, ?, 'APPLIED_SIMULATED', 'SYSTEM', ?, ?)`).run(createIdentifier('decision-event'), decision.decisionId, createdAt, json({ farms: applied.map(item => item.farmId), financialTotals }));
    return { status: 'APPLIED_SIMULATED', decisionId: decision.decisionId, workflowId: decision.workflowId, appliedAt: createdAt, farms: applied, financialTotals };
  });
}

function listDecisionHistory({ limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  return getDatabase().prepare('SELECT proposal_json, status, created_at, updated_at FROM decision_proposals ORDER BY created_at DESC LIMIT ?').all(safeLimit).map(row => ({ ...JSON.parse(row.proposal_json), executionStatus: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
}

function listSimulatedLedger({ limit = 100 } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  return getDatabase().prepare('SELECT * FROM simulated_financial_ledger ORDER BY created_at DESC LIMIT ?').all(safeLimit).map(row => ({
    ledgerEntryId: row.ledger_entry_id, decisionId: row.decision_id, optimizerRunId: row.optimizer_run_id,
    farmId: row.farm_id, deliveryStart: row.delivery_start_utc, deliveryEnd: row.delivery_end_utc,
    appliedAt: row.applied_at, exportedEnergyMWh: row.exported_energy_mwh, importedEnergyMWh: row.imported_energy_mwh,
    batteryThroughputMWh: row.battery_throughput_mwh, priceINRPerMWh: row.price_inr_per_mwh,
    grossSaleRevenueINR: row.gross_sale_revenue_inr, purchaseCostINR: row.purchase_cost_inr,
    transactionFeesINR: row.transaction_fees_inr, degradationCostINR: row.degradation_cost_inr,
    netValueINR: row.net_value_inr, currency: row.currency, status: row.status, sourceType: row.source_type,
    configurationVersion: row.configuration_version, calculation: JSON.parse(row.calculation_json), createdAt: row.created_at,
  }));
}

function loadDecision(decisionId) {
  const row = getDatabase().prepare('SELECT proposal_json, status, updated_at FROM decision_proposals WHERE decision_id=?').get(decisionId);
  if (!row) return undefined;
  return { ...JSON.parse(row.proposal_json), executionStatus: row.status, executedAt: row.status === 'PENDING' ? null : row.updated_at };
}

function calculateAcceptedState({ decision, farm, persistedState, chargingEfficiency, dischargingEfficiency }) {
  const before = { ...persistedState };
  const after = { ...persistedState };
  let appliedQuantityMW = 0;

  if (decision.decision === 'BUY') {
    const quantity = Math.min(decision.quantityMW, after.gridImportLimitMW - after.currentImportMW, farm.batteryMaxPowerMW);
    appliedQuantityMW = quantity;
    after.currentImportMW = Number((after.currentImportMW + quantity).toFixed(1));
    after.batterySocPct = Number(Math.min(farm.batterySafeChargePct, after.batterySocPct + quantity * chargingEfficiency / farm.batteryCapacityMWh * 100).toFixed(1));
    after.batteryPowerMW = Number((-quantity).toFixed(1));
  }
  if (decision.decision === 'SELL') {
    const quantity = Math.min(decision.quantityMW, after.gridExportLimitMW - after.currentExportMW, farm.batteryMaxPowerMW);
    appliedQuantityMW = quantity;
    const generationSurplus = Math.max(0, farm.currentGenerationMW - after.currentExportMW, farm.curtailmentMW || 0);
    const discharge = Math.max(0, quantity - generationSurplus);
    after.currentExportMW = Number((after.currentExportMW + quantity).toFixed(1));
    after.batterySocPct = Number(Math.max(after.reservePct, after.batterySocPct - discharge / dischargingEfficiency / farm.batteryCapacityMWh * 100).toFixed(1));
    after.batteryPowerMW = Number(discharge.toFixed(1));
    after.revenueToday = Math.round(after.revenueToday + quantity * decision.marketPricePerMWh);
  }
  return { before, after, appliedQuantityMW };
}

function persistDecisionAction({ decision, action, farm, chargingEfficiency, dischargingEfficiency }) {
  const createdAt = new Date().toISOString();
  const finalStatus = action === 'ACCEPT' ? 'APPLIED' : 'DISMISSED';
  return transaction(db => {
    const current = db.prepare('SELECT status FROM decision_proposals WHERE decision_id=?').get(decision.decisionId);
    if (!current) throw new Error(`Decision ${decision.decisionId} is not persisted`);
    if (current.status !== 'PENDING') {
      const error = new Error(`Decision ${decision.decisionId} is already ${current.status}`);
      error.code = 'DECISION_ALREADY_APPLIED';
      throw error;
    }
    const persisted = getPersistedFarmState(decision.farmId, db);
    if (!persisted) throw new Error(`Persisted operational state is missing for farm ${decision.farmId}`);
    const stateChange = action === 'ACCEPT'
      ? calculateAcceptedState({ decision, farm, persistedState: persisted.state, chargingEfficiency, dischargingEfficiency })
      : { before: persisted.state, after: persisted.state, appliedQuantityMW: 0 };
    let stateVersion = persisted.stateVersion;

    if (action === 'ACCEPT' && decision.decision !== 'HOLD') {
      stateVersion += 1;
      const updated = db.prepare(`UPDATE simulated_farm_state
        SET state_version=?, state_json=?, source_type='USER_CONFIGURED_SIMULATION', source_ref=?, updated_at=?
        WHERE farm_id=? AND state_version=?`)
        .run(stateVersion, json(stateChange.after), `decision:${decision.decisionId}`, createdAt, decision.farmId, persisted.stateVersion);
      if (updated.changes !== 1) {
        const error = new Error(`Operational state changed concurrently for farm ${decision.farmId}`);
        error.code = 'STATE_VERSION_CONFLICT';
        throw error;
      }
    }
    db.prepare('UPDATE decision_proposals SET status=?, updated_at=? WHERE decision_id=?').run(finalStatus, createdAt, decision.decisionId);
    db.prepare(`INSERT INTO decision_events
      (decision_event_id, decision_id, event_type, actor_type, created_at, metadata_json)
      VALUES (?, ?, ?, 'USER', ?, ?)`)
      .run(createIdentifier('decision-event'), decision.decisionId, action === 'ACCEPT' ? 'APPROVED_AND_APPLIED_SIMULATION' : 'DISMISSED', createdAt, json({ before: stateChange.before, after: stateChange.after, stateVersion }));
    if (action === 'ACCEPT') {
      db.prepare(`INSERT INTO applied_simulated_allocations
        (applied_allocation_id, decision_id, farm_id, action, power_mw, state_before_json, state_after_json, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(createIdentifier('applied-allocation'), decision.decisionId, decision.farmId, decision.decision, stateChange.appliedQuantityMW, json(stateChange.before), json(stateChange.after), createdAt);
      const revenueDeltaMinorUnits = Math.round((stateChange.after.revenueToday - stateChange.before.revenueToday) * 100);
      db.prepare(`INSERT INTO financial_ledger
        (ledger_entry_id, decision_id, farm_id, entry_type, amount_minor_units, currency, status, source_type, calculation_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'INR', ?, 'USER_CONFIGURED_SIMULATION', ?, ?)`)
        .run(
          createIdentifier('ledger'),
          decision.decisionId,
          decision.farmId,
          decision.decision === 'SELL' ? 'SIMULATED_EXPORT_REVENUE' : decision.decision === 'BUY' ? 'SIMULATED_IMPORT_COST' : 'NO_TRANSACTION',
          decision.decision === 'SELL' ? revenueDeltaMinorUnits : null,
          decision.decision === 'HOLD' ? 'NOT_APPLICABLE' : 'INCOMPLETE_ASSUMPTIONS',
          json({ powerMW: stateChange.appliedQuantityMW, pricePerMWh: decision.marketPricePerMWh, durationHours: null, note: 'Legacy state mutation retained; duration and complete economics are unavailable.' }),
          createdAt,
        );
    }
    return { status: finalStatus, createdAt, ...stateChange, stateVersion };
  });
}

module.exports = { saveOptimizerScenario, saveDecisionProposal, loadDecision, persistDecisionAction, persistPortfolioDecisionAction, listDecisionHistory, listSimulatedLedger };


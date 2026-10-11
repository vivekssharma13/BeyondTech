const SOURCE_REF = 'backend/config/examples/integrated_demo_profile.js';
const configured = (value, unit = null, note = 'Fictional demonstration assumption; not verified operational or market data.') => ({
  value, unit, sourceType: 'USER_CONFIGURED_SIMULATION', sourceRef: SOURCE_REF, note,
});

const profiles = {
  NORMAL_MARKET: { displayName: 'Normal Market', basePriceINRPerMWh: 6200, demandAmplitude: 0.18, renewableInfluence: 0.12, peakPremium: 0.16, scarcityPremium: 0.08, volatility: 0.025, phase: 0.4, events: [] },
  HIGH_DEMAND: { displayName: 'High Demand', basePriceINRPerMWh: 6900, demandAmplitude: 0.27, renewableInfluence: 0.10, peakPremium: 0.28, scarcityPremium: 0.18, volatility: 0.03, phase: 0.8, events: [{ startHour: 17, durationHours: 4, priceAdderINRPerMWh: 900, label: 'Configured fictional evening demand event' }] },
  RENEWABLE_SURPLUS: { displayName: 'Renewable Surplus', basePriceINRPerMWh: 5600, demandAmplitude: 0.14, renewableInfluence: 0.28, peakPremium: 0.12, scarcityPremium: 0.04, volatility: 0.02, phase: 1.2, events: [{ startHour: 10, durationHours: 5, priceAdderINRPerMWh: -700, label: 'Configured fictional renewable-surplus event' }] },
  VOLATILE_MARKET: { displayName: 'Volatile Market', basePriceINRPerMWh: 6400, demandAmplitude: 0.22, renewableInfluence: 0.15, peakPremium: 0.22, scarcityPremium: 0.15, volatility: 0.09, phase: 2.1, events: [{ startHour: 29, durationHours: 3, priceAdderINRPerMWh: 1300, label: 'Configured fictional scarcity event' }] },
};

module.exports = {
  profileId: 'gridline-integrated-demo-v1',
  description: 'Explicitly activated fictional market, economics, optimization, and AI budget assumptions.',
  economics: {
    sharedFleetLimits: { gridImportCapacityMW: configured(90, 'MW'), gridExportCapacityMW: configured(300, 'MW') },
    battery: { degradationCostPerMWh: configured(180, 'INR_PER_MWH') },
    economics: {
      marketTransactionFeePerMWh: configured(25, 'INR_PER_MWH'),
      importTariffPerMWh: configured(220, 'INR_PER_MWH'),
      exportTariffPerMWh: configured(35, 'INR_PER_MWH'),
    },
    optimization: {
      riskAssumptions: configured({ uncertaintyPenaltyPerMWh: 80, reserveBufferPct: 3 }, 'STRUCTURED_POLICY'),
      strategyPresets: configured({
        BALANCED: { version: 1, economicWeight: 1, curtailmentPenaltyINRPerMWh: 250, cyclingPenaltyINRPerMWh: 60, terminalSocValueFactor: 0.35 },
        PROFIT_FOCUS: { version: 1, economicWeight: 1, curtailmentPenaltyINRPerMWh: 40, cyclingPenaltyINRPerMWh: 15, terminalSocValueFactor: 0.15 },
        CONSERVATIVE: { version: 1, economicWeight: 0.85, curtailmentPenaltyINRPerMWh: 120, cyclingPenaltyINRPerMWh: 220, terminalSocValueFactor: 0.8 },
        GREEN_FOCUS: { version: 1, economicWeight: 0.75, curtailmentPenaltyINRPerMWh: 1400, cyclingPenaltyINRPerMWh: 80, terminalSocValueFactor: 0.25 },
      }, 'STRUCTURED_POLICY'),
    },
  },
  aiLimits: {
    maximumToolCalls: configured(3, 'COUNT'), maximumCostMinorUnits: configured(100, 'INR_MINOR_UNITS'),
    timeoutMs: configured(20000, 'MILLISECONDS'), maximumOutputTokens: configured(2500, 'TOKENS'), retryLimit: configured(1, 'COUNT'),
    allowDeterministicFallback: configured(true, 'BOOLEAN', 'Explicit demonstration fallback; still requires human approval.'),
  },
  marketSimulation: {
    activeScenarioId: configured('NORMAL_MARKET'), scenarioVersion: configured(1, 'VERSION'), scenarios: profiles,
  },
};

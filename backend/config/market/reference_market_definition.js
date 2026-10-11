const REFERENCE_MARKET_DEFINITION = Object.freeze({
  marketId: 'INDIA_SIMULATED_REFERENCE_MARKET',
  definitionVersion: 1,
  displayName: 'India Simulated Reference Market',
  marketType: 'FICTIONAL_WHOLESALE_ELECTRICITY_REFERENCE',
  referencePricingZone: 'SHARED_PORTFOLIO_REFERENCE_PRICE',
  currency: 'INR',
  priceUnit: 'INR_PER_MWH',
  nativeIntervalMinutes: 15,
  marketTimezone: 'Asia/Kolkata',
  sourceMode: 'UNAVAILABLE',
  dataProvenance: {
    sourceType: 'UNAVAILABLE',
    sourceRef: 'backend/config/market/reference_market_definition.js',
    note: 'Contract only. No historical dataset or demo price scenario is active by default.',
  },
  congestionLimitations: 'One fictional shared portfolio reference price; real congestion-based area prices are not represented.',
  configurationVersion: 1,
});

module.exports = { REFERENCE_MARKET_DEFINITION };

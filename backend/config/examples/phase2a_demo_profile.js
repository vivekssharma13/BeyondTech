const SOURCE_REF = 'backend/config/examples/phase2a_demo_profile.js';
const configured = (value, unit = null, note = 'Fictional demonstration assumption; not verified equipment data.') => ({
  value, unit, sourceType: 'USER_CONFIGURED_SIMULATION', sourceRef: SOURCE_REF, note,
});

module.exports = {
  profileId: 'phase2a-demo-v1',
  description: 'Explicitly activated fictional locations and equipment assumptions for the four existing demo farms.',
  farms: {
    sunpeak: {
      latitude: configured(27.2, 'DEGREES'), longitude: configured(71.0, 'DEGREES'), timezone: configured('Asia/Kolkata'), elevationM: configured(225, 'METERS'),
      installedAcCapacityMW: configured(120, 'MW'), availabilityPct: configured(99.1, 'PERCENT'),
      solar: {
        panelTiltDeg: configured(25, 'DEGREES'), panelAzimuthDeg: configured(180, 'DEGREES_CLOCKWISE_FROM_NORTH'), dcAcRatio: configured(1.2, 'RATIO'),
        inverterEfficiency: configured(0.98, 'RATIO'), systemLossPct: configured(14, 'PERCENT'), temperatureCoefficientPctPerC: configured(-0.35, 'PERCENT_PER_C'),
        nominalOperatingCellTemperatureC: configured(45, 'CELSIUS'), groundAlbedo: configured(0.2, 'RATIO'),
      },
    },
    desertbloom: {
      latitude: configured(23.2, 'DEGREES'), longitude: configured(69.7, 'DEGREES'), timezone: configured('Asia/Kolkata'), elevationM: configured(80, 'METERS'),
      installedAcCapacityMW: configured(80, 'MW'), availabilityPct: configured(96.8, 'PERCENT'),
      solar: {
        panelTiltDeg: configured(22, 'DEGREES'), panelAzimuthDeg: configured(180, 'DEGREES_CLOCKWISE_FROM_NORTH'), dcAcRatio: configured(1.2, 'RATIO'),
        inverterEfficiency: configured(0.98, 'RATIO'), systemLossPct: configured(14, 'PERCENT'), temperatureCoefficientPctPerC: configured(-0.35, 'PERCENT_PER_C'),
        nominalOperatingCellTemperatureC: configured(45, 'CELSIUS'), groundAlbedo: configured(0.22, 'RATIO'),
      },
    },
    coastal: {
      latitude: configured(8.1, 'DEGREES'), longitude: configured(77.5, 'DEGREES'), timezone: configured('Asia/Kolkata'), elevationM: configured(15, 'METERS'),
      installedAcCapacityMW: configured(150, 'MW'), availabilityPct: configured(98.4, 'PERCENT'),
      wind: {
        hubHeightM: configured(100, 'METERS'), turbineCount: configured(50, 'COUNT'), turbineRatedPowerMW: configured(3, 'MW'),
        cutInSpeedMps: configured(3, 'M_PER_S'), ratedSpeedMps: configured(12, 'M_PER_S'), cutOutSpeedMps: configured(25, 'M_PER_S'),
        windShearExponent: configured(0.14, 'EXPONENT'), referenceAirDensityKgM3: configured(1.225, 'KG_PER_M3'),
      },
    },
    highland: {
      latitude: configured(15.3, 'DEGREES'), longitude: configured(75.7, 'DEGREES'), timezone: configured('Asia/Kolkata'), elevationM: configured(720, 'METERS'),
      installedAcCapacityMW: configured(100, 'MW'), availabilityPct: configured(94.6, 'PERCENT'),
      wind: {
        hubHeightM: configured(100, 'METERS'), turbineCount: configured(40, 'COUNT'), turbineRatedPowerMW: configured(2.5, 'MW'),
        cutInSpeedMps: configured(3, 'M_PER_S'), ratedSpeedMps: configured(12, 'M_PER_S'), cutOutSpeedMps: configured(25, 'M_PER_S'),
        windShearExponent: configured(0.14, 'EXPONENT'), referenceAirDensityKgM3: configured(1.225, 'KG_PER_M3'),
      },
    },
  },
};

const profile = require('../config/examples/integrated_demo_profile');
const generationProfile = require('../config/examples/phase2a_demo_profile');
const { getActiveConfiguration, createConfigurationVersion } = require('../services/configuration_service');

const active = getActiveConfiguration();
const configuration = structuredClone(active.configuration);
for (const [farmId, values] of Object.entries(generationProfile.farms)) {
  configuration.generationSimulation.farms[farmId] = { ...configuration.generationSimulation.farms[farmId], ...values };
}
configuration.sharedFleetLimits = profile.economics.sharedFleetLimits;
configuration.battery.degradationCostPerMWh = profile.economics.battery.degradationCostPerMWh;
configuration.economics = profile.economics.economics;
configuration.optimization = profile.economics.optimization;
configuration.aiLimits = profile.aiLimits;
configuration.marketSimulation = profile.marketSimulation;
const created = createConfigurationVersion(configuration, { createdBy: `LOCAL_CLI:${profile.profileId}`, sourceType: 'USER_CONFIGURED_SIMULATION' });
console.log(JSON.stringify({ activated: profile.profileId, configurationVersion: created.configVersion, sourceType: created.sourceType }, null, 2));

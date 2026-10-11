const profile = require('../config/examples/phase2a_demo_profile');
const { getActiveConfiguration, createConfigurationVersion } = require('../services/configuration_service');

const active = getActiveConfiguration();
const configuration = structuredClone(active.configuration);
for (const [farmId, values] of Object.entries(profile.farms)) {
  configuration.generationSimulation.farms[farmId] = {
    ...configuration.generationSimulation.farms[farmId],
    ...values,
  };
}
const created = createConfigurationVersion(configuration, {
  createdBy: `LOCAL_CLI:${profile.profileId}`,
  sourceType: 'USER_CONFIGURED_SIMULATION',
});
console.log(JSON.stringify({ activated: profile.profileId, configurationVersion: created.configVersion, sourceType: created.sourceType }, null, 2));

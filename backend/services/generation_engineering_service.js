const MODEL_VERSION = 'weather-engineering-v1';
const SOURCE_TYPE = 'WEATHER_DRIVEN_ENGINEERING_SIMULATION';
const AIR_GAS_CONSTANT = 287.05;

const radians = degrees => degrees * Math.PI / 180;
const degrees = value => value * 180 / Math.PI;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function solarPosition(timestamp, latitude, longitude) {
  const date = new Date(timestamp);
  const dayStart = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - dayStart) / 86400000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (minutes / 60 - 12) / 24);
  const equationOfTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const hourAngle = radians(((minutes + equationOfTime + 4 * longitude) / 4) - 180);
  const latitudeRad = radians(latitude);
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(latitudeRad) * Math.sin(declination)
    - Math.sin(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(latitudeRad) * Math.sin(declination)
    + Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle);
  return { elevationDeg: degrees(Math.asin(clamp(up, -1, 1))), vector: { east, north, up } };
}

function solarGenerationMW(weather, config) {
  const position = solarPosition(weather.validAt, config.latitude, config.longitude);
  if (position.elevationDeg <= 0 || Number(weather.is_day) !== 1) return 0;
  const tilt = radians(config.panelTiltDeg);
  const azimuth = radians(config.panelAzimuthDeg);
  const panelNormal = {
    east: Math.sin(tilt) * Math.sin(azimuth),
    north: Math.sin(tilt) * Math.cos(azimuth),
    up: Math.cos(tilt),
  };
  const incidence = Math.max(0, position.vector.east * panelNormal.east
    + position.vector.north * panelNormal.north + position.vector.up * panelNormal.up);
  const ghi = Math.max(0, weather.shortwave_radiation);
  const dni = Math.max(0, weather.direct_normal_irradiance);
  const dhi = Math.max(0, weather.diffuse_radiation);
  const planeOfArrayWm2 = Math.max(0, dni * incidence
    + dhi * (1 + Math.cos(tilt)) / 2
    + ghi * config.groundAlbedo * (1 - Math.cos(tilt)) / 2);
  const cellTemperatureC = weather.temperature_2m + (config.nominalOperatingCellTemperatureC - 20) / 800 * planeOfArrayWm2;
  const temperatureFactor = Math.max(0, 1 + config.temperatureCoefficientPctPerC / 100 * (cellTemperatureC - 25));
  const dcCapacityMW = config.installedAcCapacityMW * config.dcAcRatio;
  const dcPowerMW = dcCapacityMW * planeOfArrayWm2 / 1000 * temperatureFactor * (1 - config.systemLossPct / 100);
  const availableCapacityMW = config.installedAcCapacityMW * config.availabilityPct / 100;
  return clamp(dcPowerMW * config.inverterEfficiency, 0, availableCapacityMW);
}

function windSpeedAtHub(weather, config) {
  const candidates = [
    { height: 80, speed: weather.wind_speed_80m },
    { height: 120, speed: weather.wind_speed_120m },
  ].filter(item => Number.isFinite(item.speed));
  if (!candidates.length) throw new TypeError('No supported hub-height wind speed is available');
  const reference = candidates.sort((a, b) => Math.abs(a.height - config.hubHeightM) - Math.abs(b.height - config.hubHeightM))[0];
  return reference.speed * (config.hubHeightM / reference.height) ** config.windShearExponent;
}

function windGenerationMW(weather, config) {
  const speed = windSpeedAtHub(weather, config);
  if (speed < config.cutInSpeedMps || speed >= config.cutOutSpeedMps) return 0;
  const fraction = speed >= config.ratedSpeedMps ? 1 : clamp(
    (speed ** 3 - config.cutInSpeedMps ** 3) / (config.ratedSpeedMps ** 3 - config.cutInSpeedMps ** 3),
    0,
    1,
  );
  const density = weather.surface_pressure * 100 / (AIR_GAS_CONSTANT * (weather.temperature_2m + 273.15));
  const densityFactor = clamp(density / config.referenceAirDensityKgM3, 0.85, 1.15);
  const turbineOutputMW = Math.min(config.turbineRatedPowerMW, config.turbineRatedPowerMW * fraction * densityFactor);
  const availableCapacityMW = config.installedAcCapacityMW * config.availabilityPct / 100;
  return clamp(turbineOutputMW * config.turbineCount, 0, availableCapacityMW);
}

function calculateGenerationMW(farmType, weather, config) {
  const value = farmType === 'SOLAR' ? solarGenerationMW(weather, config) : windGenerationMW(weather, config);
  return Number(value.toFixed(3));
}

module.exports = {
  MODEL_VERSION,
  SOURCE_TYPE,
  solarPosition,
  solarGenerationMW,
  windSpeedAtHub,
  windGenerationMW,
  calculateGenerationMW,
};

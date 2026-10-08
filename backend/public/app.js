const solarFields = [
  'temperature_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid',
  'cloud_cover_high', 'shortwave_radiation', 'direct_radiation',
  'diffuse_radiation', 'direct_normal_irradiance', 'sunshine_duration',
  'daylight_duration'
];
const windFields = [
  'temperature_2m', 'wind_speed_10m', 'wind_speed_80m', 'wind_speed_120m',
  'wind_direction_10m', 'wind_direction_80m', 'wind_gusts_10m', 'pressure_msl'
];

function addFields(containerId, names) {
  const container = document.getElementById(containerId);
  names.forEach(name => {
    const label = document.createElement('label');
    label.textContent = name;
    label.htmlFor = name;
    const input = document.createElement('input');
    input.id = name;
    input.name = name;
    input.type = 'number';
    input.step = 'any';
    input.placeholder = 'Use JSON default';
    label.appendChild(input);
    container.appendChild(label);
  });
}

addFields('solar-fields', solarFields);
addFields('wind-fields', windFields);

document.getElementById('prediction-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('submit');
  const status = document.getElementById('status');
  const inputs = {};
  [...solarFields, ...windFields].forEach(name => {
    const value = document.getElementById(name).value;
    if (value !== '') inputs[name] = Number(value);
  });
  button.disabled = true;
  status.textContent = 'Calculating...';
  try {
    const response = await fetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: document.getElementById('date').value, inputs })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Prediction failed');
    document.getElementById('solar-output').textContent = `${result.solar_power.toFixed(2)} AC units`;
    document.getElementById('wind-output').textContent = `${result.wind_power.toFixed(2)} AC units`;
    document.getElementById('results').hidden = false;
    const sourceMessage = result.used_nearest_weather
      ? `Weather from ${result.weather_date_used} was used because the requested date is outside the dataset.`
      : 'Weather matched the requested date.';
    status.textContent = `${sourceMessage} ${result.used_defaults.length
      ? 'Missing fields were filled from the weather JSON.'
      : 'All model inputs were supplied.'}`;
  } catch (error) {
    status.textContent = error.message;
    document.getElementById('results').hidden = true;
  } finally {
    button.disabled = false;
  }
});
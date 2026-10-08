"""Read one prediction request from stdin and write one JSON response."""

import json
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
WEATHER_JSON = ROOT / "data" / "solarAndWindData.json"

SOLAR_FIELDS = [
    "temperature_2m", "cloud_cover", "cloud_cover_low", "cloud_cover_mid",
    "cloud_cover_high", "shortwave_radiation", "direct_radiation",
    "diffuse_radiation", "direct_normal_irradiance", "sunshine_duration",
    "daylight_duration",
]
WIND_FIELDS = [
    "temperature_2m", "wind_speed_10m", "wind_speed_80m", "wind_speed_120m",
    "wind_direction_10m", "wind_direction_80m", "wind_gusts_10m", "pressure_msl",
]
NO_WIND_FIELDS = ["wind_speed_10m", "wind_speed_80m", "wind_speed_120m", "wind_gusts_10m"]
NO_SOLAR_FIELDS = [
    "shortwave_radiation", "direct_radiation", "diffuse_radiation",
    "direct_normal_irradiance", "sunshine_duration",
]


def load_weather():
    payload = json.loads(WEATHER_JSON.read_text())
    rows = pd.DataFrame(payload["hourly"])
    rows["timestamp"] = pd.to_datetime(rows.pop("time"), errors="coerce")
    rows["daylight_duration"] = rows.get("sunshine_duration", 0)
    return rows.set_index("timestamp")


def number(value):
    if value is None or value == "":
        return None
    return float(value)


def main():
    request = json.load(sys.stdin)
    date_text = str(request.get("date", ""))
    if len(date_text) == 10:
        date_text += "T00:00"
    timestamp = pd.Timestamp(datetime.fromisoformat(date_text))
    weather = load_weather()
    weather_timestamp = timestamp
    used_nearest_weather = False
    if timestamp not in weather.index:
        same_calendar_time = weather[
            (weather.index.month == timestamp.month)
            & (weather.index.day == timestamp.day)
            & (weather.index.hour == timestamp.hour)
        ]
        candidates = same_calendar_time if not same_calendar_time.empty else weather
        weather_timestamp = min(candidates.index, key=lambda value: abs(value - timestamp))
        used_nearest_weather = True

    supplied = request.get("inputs", {})
    row = weather.loc[weather_timestamp].to_dict()
    for field in SOLAR_FIELDS + WIND_FIELDS:
        value = number(supplied.get(field))
        if value is not None:
            row[field] = value
    row["hour_sin"] = np.sin(2 * np.pi * timestamp.hour / 24)
    row["hour_cos"] = np.cos(2 * np.pi * timestamp.hour / 24)
    row["day_sin"] = np.sin(2 * np.pi * timestamp.dayofyear / 365.25)
    row["day_cos"] = np.cos(2 * np.pi * timestamp.dayofyear / 365.25)
    supplied_is_day = number(supplied.get("is_day"))
    if supplied_is_day is not None:
        row["is_day"] = supplied_is_day

    result = {
        "date": timestamp.isoformat(),
        "weather_date_used": weather_timestamp.isoformat(),
        "used_nearest_weather": used_nearest_weather,
        "used_defaults": [],
        "no_solar_rule_applied": False,
        "no_wind_rule_applied": False,
    }
    for target in ["solar_power", "wind_power"]:
        bundle = joblib.load(ROOT / f"best_{target}_model.joblib")
        features = bundle["features"]
        values = []
        for feature in features:
            value = number(row.get(feature))
            if value is None or not np.isfinite(value):
                raise ValueError(f"No usable value for {feature}")
            values.append(value)
            if feature not in supplied and feature not in result["used_defaults"]:
                result["used_defaults"].append(feature)
        scaled = bundle["bundle"]["model"].predict(
            bundle["bundle"]["x_scaler"].transform(pd.DataFrame([values], columns=features))
        )
        prediction = bundle["bundle"]["y_scaler"].inverse_transform(np.asarray(scaled).reshape(-1, 1))[0, 0]
        physical_zero_rule = False
        if target == "solar_power" and all(float(row[field]) <= 0 for field in NO_SOLAR_FIELDS):
            prediction = 0.0
            result["no_solar_rule_applied"] = True
            physical_zero_rule = True
        if target == "wind_power" and all(float(row[field]) <= 0 for field in NO_WIND_FIELDS):
            prediction = 0.0
            result["no_wind_rule_applied"] = True
            physical_zero_rule = True
        prediction = max(0.0, float(prediction))
        calibration = bundle.get("calibration", {})
        radius = float(calibration.get("radius", 0.0))
        result[target] = prediction
        result[f"{target}_lower"] = 0.0 if physical_zero_rule else max(0.0, prediction - radius)
        result[f"{target}_upper"] = 0.0 if physical_zero_rule else prediction + radius
        result[f"{target}_confidence"] = 100.0 if physical_zero_rule else float(calibration.get("confidence", 0.0) * 100)
        result[f"{target}_confidence_method"] = "physical_zero_rule" if physical_zero_rule else calibration.get("method", "unavailable")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
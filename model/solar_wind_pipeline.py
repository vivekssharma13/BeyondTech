"""Convert weather JSON to CSV, train solar/wind models, and validate them."""

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import MinMaxScaler

ROOT = Path(__file__).resolve().parent
WEATHER_JSON = ROOT / "data" / "solarAndWindData.json"
GENERATION_CSV = ROOT / "data" / "Plant_1_Generation_Data.csv"
OUTPUT_CSV = ROOT / "solar_wind_training_data.csv"
RESULTS_JSON = ROOT / "model_results.json"
SEED = 42
CONFIDENCE_LEVEL = 0.90

SOLAR_FEATURES = [
    "temperature_2m", "cloud_cover", "cloud_cover_low", "cloud_cover_mid",
    "cloud_cover_high", "shortwave_radiation", "direct_radiation",
    "diffuse_radiation", "direct_normal_irradiance", "sunshine_duration",
    "daylight_duration",
]
WIND_FEATURES = [
    "temperature_2m", "wind_speed_10m", "wind_speed_80m", "wind_speed_120m",
    "wind_direction_10m", "wind_direction_80m", "wind_gusts_10m", "pressure_msl",
]
TIME_FEATURES = ["hour_sin", "hour_cos", "day_sin", "day_cos", "is_day"]


def load_and_prepare_data():
    payload = json.loads(WEATHER_JSON.read_text())
    hourly = pd.DataFrame(payload["hourly"])
    hourly["timestamp"] = pd.to_datetime(hourly.pop("time"), errors="coerce")

    daily = pd.DataFrame(payload.get("daily", {}))
    if not daily.empty and "time" in daily:
        daily["timestamp"] = pd.to_datetime(daily.pop("time"), errors="coerce")
        daily = daily.rename(columns={"sunrise": "sunrise", "sunset": "sunset"})
        daily_columns = [column for column in ["timestamp", "daylight_duration"] if column in daily]
        hourly = hourly.merge(daily[daily_columns], on="timestamp", how="left")
    if "daylight_duration" not in hourly:
        hourly["daylight_duration"] = hourly.get("sunshine_duration", 0)

    generation = pd.read_csv(GENERATION_CSV)
    generation["timestamp"] = pd.to_datetime(
        generation["DATE_TIME"], format="%d-%m-%Y %H:%M", errors="coerce"
    ).dt.floor("h")
    measured = generation.groupby("timestamp", as_index=False)["AC_POWER"].mean()
    measured = measured.rename(columns={"AC_POWER": "solar_power_measured"})
    data = hourly.merge(measured, on="timestamp", how="left")
    data = data.sort_values("timestamp").dropna(subset=["timestamp"]).reset_index(drop=True)

    numeric_columns = [column for column in data.columns if column not in {"timestamp", "is_day"}]
    for column in numeric_columns:
        data[column] = pd.to_numeric(data[column], errors="coerce")
    data["daylight_duration"] = data["daylight_duration"].fillna(data["sunshine_duration"])
    data["is_day"] = pd.to_numeric(data["is_day"], errors="coerce").fillna(0)
    data["hour_sin"] = np.sin(2 * np.pi * data["timestamp"].dt.hour / 24)
    data["hour_cos"] = np.cos(2 * np.pi * data["timestamp"].dt.hour / 24)
    data["day_sin"] = np.sin(2 * np.pi * data["timestamp"].dt.dayofyear / 365.25)
    data["day_cos"] = np.cos(2 * np.pi * data["timestamp"].dt.dayofyear / 365.25)

    measured_mask = data["solar_power_measured"].notna()
    positive_measured = data.loc[measured_mask & (data["shortwave_radiation"] > 0)]
    ratio = (positive_measured["solar_power_measured"] / positive_measured["shortwave_radiation"]).median()
    if not np.isfinite(ratio) or ratio <= 0:
        ratio = 1.0
    solar_fallback = data["shortwave_radiation"].clip(lower=0).fillna(0) * ratio
    data["solar_power"] = data["solar_power_measured"].fillna(solar_fallback).clip(lower=0)
    data["solar_power_source"] = np.where(measured_mask, "Plant_1_AC_POWER", "radiation_calibration")

    rng = np.random.default_rng(SEED)
    data["wind_power"] = data["solar_power"] * rng.uniform(0.8, 1.2, len(data))
    data["wind_power"] = data["wind_power"].clip(lower=0)
    data["wind_power_source"] = "synthetic_solar_range_plus_or_minus_20_percent"
    return data


def model_candidates():
    return {
        "ExtraTrees": ExtraTreesRegressor(n_estimators=250, min_samples_leaf=2, random_state=SEED, n_jobs=-1),
        "RandomForest": RandomForestRegressor(n_estimators=250, min_samples_leaf=2, random_state=SEED, n_jobs=-1),
        "HistGradientBoosting": HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, random_state=SEED),
    }


def fit_normalized(model, features, target):
    x_scaler = MinMaxScaler()
    y_scaler = MinMaxScaler()
    scaled_features = x_scaler.fit_transform(features)
    scaled_target = y_scaler.fit_transform(target.to_numpy().reshape(-1, 1)).ravel()
    model.fit(scaled_features, scaled_target)
    return {"model": model, "x_scaler": x_scaler, "y_scaler": y_scaler}


def predict(bundle, features):
    scaled = bundle["model"].predict(bundle["x_scaler"].transform(features))
    return bundle["y_scaler"].inverse_transform(np.asarray(scaled).reshape(-1, 1)).ravel()


def split_data(data):
    days = data["timestamp"].dt.normalize().drop_duplicates().sort_values().to_numpy()
    train_end = pd.Timestamp(days[int(len(days) * 0.60)])
    test_end = pd.Timestamp(days[int(len(days) * 0.80)])
    return (
        data[data["timestamp"] < train_end].copy(),
        data[(data["timestamp"] >= train_end) & (data["timestamp"] < test_end)].copy(),
        data[data["timestamp"] >= test_end].copy(),
    )


def train_target(train, test, target_name, feature_columns):
    train = train.dropna(subset=feature_columns + [target_name]).copy()
    test = test.dropna(subset=feature_columns + [target_name]).copy()
    best = None
    for name, estimator in model_candidates().items():
        bundle = fit_normalized(estimator, train[feature_columns], train[target_name])
        predictions = predict(bundle, test[feature_columns])
        metrics = {
            "model": name,
            "MAE": float(mean_absolute_error(test[target_name], predictions)),
            "RMSE": float(mean_squared_error(test[target_name], predictions) ** 0.5),
            "R2": float(r2_score(test[target_name], predictions)),
        }
        if best is None or metrics["MAE"] < best["metrics"]["MAE"]:
            best = {"metrics": metrics, "bundle": bundle, "predictions": predictions}

    model_path = ROOT / f"best_{target_name}_model.joblib"
    residuals = np.abs(test[target_name].to_numpy() - best["predictions"])
    conformal_radius = float(np.quantile(residuals, CONFIDENCE_LEVEL, method="higher"))
    calibration = {
        "method": "split_conformal",
        "confidence": CONFIDENCE_LEVEL,
        "radius": conformal_radius,
        "calibration_rows": len(residuals),
    }
    joblib.dump({"target": target_name, "features": feature_columns, "bundle": best["bundle"], "calibration": calibration}, model_path)
    output = test[["timestamp", target_name]].copy()
    output["prediction"] = best["predictions"]
    output.to_csv(ROOT / f"{target_name}_validation_predictions.csv", index=False)
    return best["metrics"], model_path.name


def run(mode):
    data = load_and_prepare_data()
    data.to_csv(OUTPUT_CSV, index=False)
    train, test, validation = split_data(data)
    data["split"] = "validation"
    data.loc[train.index, "split"] = "train"
    data.loc[test.index, "split"] = "test"
    data.to_csv(OUTPUT_CSV, index=False)

    if mode == "validate":
        if not (ROOT / "best_solar_power_model.joblib").exists() or not (ROOT / "best_wind_power_model.joblib").exists():
            raise SystemExit("Run training first: python solar_wind_pipeline.py")
        evaluation = {}
        for target in ["solar_power", "wind_power"]:
            bundle = joblib.load(ROOT / f"best_{target}_model.joblib")
            features = bundle["features"]
            ready = validation.dropna(subset=features + [target])
            predictions = predict(bundle["bundle"], ready[features])
            evaluation[target] = {
                "MAE": float(mean_absolute_error(ready[target], predictions)),
                "RMSE": float(mean_squared_error(ready[target], predictions) ** 0.5),
                "R2": float(r2_score(ready[target], predictions)),
            }
            print(f"VALIDATION {target}: MAE={evaluation[target]['MAE']:.3f}, RMSE={evaluation[target]['RMSE']:.3f}, R2={evaluation[target]['R2']:.3f}")
        return

    results = {"split": "60% train / 20% test / 20% validation", "models": {}}
    for target, features in [("solar_power", SOLAR_FEATURES + TIME_FEATURES), ("wind_power", WIND_FEATURES + TIME_FEATURES)]:
        metrics, model_file = train_target(train, test, target, features)
        results["models"][target] = {**metrics, "file": model_file}
        print(f"BEST {target.upper()}: {metrics['model']} | MAE={metrics['MAE']:.3f} | RMSE={metrics['RMSE']:.3f} | R2={metrics['R2']:.3f}")
    RESULTS_JSON.write_text(json.dumps(results, indent=2))
    print(f"CSV: {OUTPUT_CSV.name}\nValidation command: python solar_wind_pipeline.py validate")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=["train", "validate"], default="train")
    run(parser.parse_args().command)
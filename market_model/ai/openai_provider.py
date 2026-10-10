import json
import os
import time
import uuid
from pathlib import Path

from openai import OpenAI
from dotenv import load_dotenv

from ai.provider import AiProvider
from services.model_run_logger import write_model_run

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

MARKET_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "currentPricePerMWh": {"type": "number", "minimum": 0},
        "forecasts": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "horizon": {"type": "string", "enum": ["1h", "6h", "24h"]},
                    "predictedPricePerMWh": {"type": "number", "minimum": 0},
                    "confidencePct": {"type": "integer", "minimum": 0, "maximum": 100},
                },
                "required": ["horizon", "predictedPricePerMWh", "confidencePct"],
            },
        },
        "trend": {"type": "string", "enum": ["RISING", "FALLING", "STABLE"]},
        "expectedPeakPricePerMWh": {"type": "number", "minimum": 0},
        "expectedPeakAt": {"type": "string"},
        "marketStatus": {"type": "string", "enum": ["FAVORABLE", "UNFAVORABLE", "NEUTRAL"]},
        "riskLevel": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
        "newsImpact": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
        "confidencePct": {"type": "integer", "minimum": 0, "maximum": 100},
        "drivers": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
    },
    "required": [
        "currentPricePerMWh", "forecasts", "trend", "expectedPeakPricePerMWh",
        "expectedPeakAt", "marketStatus", "riskLevel", "newsImpact",
        "confidencePct", "drivers"
    ],
}


def validate_market_result(result):
    if not isinstance(result, dict):
        raise ValueError("Market model response must be a JSON object.")
    required = set(MARKET_SCHEMA["required"])
    if set(result) != required:
        raise ValueError(f"Market model response fields must be exactly: {sorted(required)}")
    numeric_fields = ["currentPricePerMWh", "expectedPeakPricePerMWh", "confidencePct"]
    if any(not isinstance(result[field], (int, float)) for field in numeric_fields):
        raise ValueError("Market response contains invalid numeric fields.")
    if not 0 <= result["confidencePct"] <= 100:
        raise ValueError("confidencePct must be between 0 and 100.")
    if result["trend"] not in {"RISING", "FALLING", "STABLE"}:
        raise ValueError("Invalid trend.")
    if result["marketStatus"] not in {"FAVORABLE", "UNFAVORABLE", "NEUTRAL"}:
        raise ValueError("Invalid marketStatus.")
    if result["riskLevel"] not in {"LOW", "MEDIUM", "HIGH"} or result["newsImpact"] not in {"LOW", "MEDIUM", "HIGH"}:
        raise ValueError("Invalid riskLevel or newsImpact.")
    forecasts = result["forecasts"]
    if not isinstance(forecasts, list) or {item.get("horizon") for item in forecasts if isinstance(item, dict)} != {"1h", "6h", "24h"}:
        raise ValueError("Forecasts must contain exactly the 1h, 6h and 24h horizons.")
    for forecast in forecasts:
        if not isinstance(forecast.get("predictedPricePerMWh"), (int, float)):
            raise ValueError("Invalid predictedPricePerMWh.")
        confidence = forecast.get("confidencePct")
        if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 100:
            raise ValueError("Forecast confidencePct must be between 0 and 100.")
    if not isinstance(result["drivers"], list) or not result["drivers"]:
        raise ValueError("At least one concise market driver is required.")
    return result

class OpenAIProvider(AiProvider):
    def __init__(self):
        api_key = os.getenv("DECISION_AI_API_KEY") or os.getenv("MARKET_AI_API_KEY") or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("DECISION_AI_API_KEY (or MARKET_AI_API_KEY/OPENAI_API_KEY) is missing.")
        base_url = os.getenv("DECISION_AI_BASE_URL") or os.getenv("MARKET_AI_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        client_options = {"api_key": api_key}
        if base_url:
            client_options["base_url"] = base_url
        self.client = OpenAI(**client_options)
        self.model = os.getenv("DECISION_AI_MODEL") or os.getenv("MARKET_AI_MODEL") or "gpt-5-mini"
        self.base_url = base_url

    def analyze(self, scraped_data):

        run_id = f"market-ai-{uuid.uuid4()}"
        started_at = time.monotonic()

        prompt = f"""
You are the Market Agent for a renewable-energy orchestration system.

Your job is to analyze external energy-market observations and determine
their implications for current and forecast electricity-market conditions.

IMPORTANT:
- The input contains observations collected by a web scraper.
- Do not assume the scraper has already interpreted the data.
- You must perform the market reasoning yourself.
- Consider both solar and wind generation.
- Consider electricity price changes.
- Consider demand and demand forecast.
- Consider grid frequency and transmission constraints.
- Consider relevant external signals/news.
- Do not invent facts that are not present in the input.
- Convert an observed INR/kWh price to INR/MWh by multiplying by 1000.
- Confidence is an integer percentage from 0 to 100.
- Output market intelligence only. Never recommend BUY, SELL, HOLD, battery
  charging/discharging, a dispatch quantity, or another operational action.
- Use ISO-8601 for expectedPeakAt. If the evidence does not establish an exact
  peak time, use the observation timestamp and reduce confidence.

Return only the fields required by the supplied JSON schema. Drivers must be
concise evidence statements, not hidden reasoning or chain-of-thought.

SCRAPER OBSERVATIONS:

{json.dumps(scraped_data, indent=2)}
"""

        try:
            response = self.client.responses.create(
                model=self.model,
                input=prompt,
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "market_forecast",
                        "strict": True,
                        "schema": MARKET_SCHEMA,
                    }
                },
            )
            parsed = json.loads(response.output_text)
            result = validate_market_result(parsed)
        except Exception as error:
            write_model_run(
                run_id=run_id,
                status="FAILED",
                model=self.model,
                base_url=self.base_url,
                duration_ms=round((time.monotonic() - started_at) * 1000),
                model_input=scraped_data,
                error={"type": type(error).__name__, "message": str(error)},
            )
            if isinstance(error, (TypeError, json.JSONDecodeError)):
                raise ValueError("Market model returned malformed JSON.") from error
            raise

        write_model_run(
            run_id=run_id,
            status="COMPLETED",
            model=self.model,
            base_url=self.base_url,
            duration_ms=round((time.monotonic() - started_at) * 1000),
            model_input=scraped_data,
            model_output=result,
        )
        return result

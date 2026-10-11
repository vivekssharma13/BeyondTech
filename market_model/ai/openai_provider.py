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

MARKET_INTELLIGENCE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "summary": {"type": "string"},
        "trend": {"type": "string", "enum": ["RISING", "FALLING", "MIXED", "STABLE"]},
        "riskLevel": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
        "drivers": {
            "type": "array", "minItems": 1, "maxItems": 6,
            "items": {
                "type": "object", "additionalProperties": False,
                "properties": {"statement": {"type": "string"}, "timestamp": {"type": ["string", "null"]}, "sourceType": {"type": "string"}},
                "required": ["statement", "timestamp", "sourceType"],
            },
        },
        "risks": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "highPriceOpportunities": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "lowPriceOpportunities": {"type": "array", "items": {"type": "string"}, "maxItems": 5},
        "limitations": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
    },
    "required": ["summary", "trend", "riskLevel", "drivers", "risks", "highPriceOpportunities", "lowPriceOpportunities", "limitations"],
}


def validate_market_intelligence(result):
    if not isinstance(result, dict) or set(result) != set(MARKET_INTELLIGENCE_SCHEMA["required"]):
        raise ValueError("Market Intelligence response has invalid fields.")
    if result["trend"] not in {"RISING", "FALLING", "MIXED", "STABLE"} or result["riskLevel"] not in {"LOW", "MEDIUM", "HIGH"}:
        raise ValueError("Market Intelligence response has invalid classifications.")
    if not isinstance(result["drivers"], list) or not result["drivers"]:
        raise ValueError("Market Intelligence requires grounded drivers.")
    forbidden = {"currentPricePerMWh", "predictedPricePerMWh", "confidencePct", "decision", "action"}
    if forbidden.intersection(result):
        raise ValueError("Market Intelligence must not create prices, confidence, or operational decisions.")
    return result


class OpenAIProvider(AiProvider):
    def __init__(self):
        api_key = os.getenv("MARKET_AI_API_KEY") or os.getenv("DECISION_AI_API_KEY") or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("MARKET_AI_API_KEY (or DECISION_AI_API_KEY/OPENAI_API_KEY) is missing.")
        base_url = os.getenv("MARKET_AI_BASE_URL") or os.getenv("DECISION_AI_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        options = {"api_key": api_key}
        if base_url:
            options["base_url"] = base_url
        self.client = OpenAI(**options)
        self.model = os.getenv("MARKET_AI_MODEL") or os.getenv("DECISION_AI_MODEL") or "gpt-5-mini"
        self.base_url = base_url

    def analyze(self, evidence):
        run_id = f"market-intelligence-{uuid.uuid4()}"
        started_at = time.monotonic()
        prompt = f"""
You are the qualitative Market Intelligence Agent for a fictional Indian electricity-market simulation.
Analyze only the supplied numerical trajectory and evidence. Explain movements, demand/supply influence,
renewable influence, scarcity, opportunities, and risks. Cite timestamps and source classifications from
the evidence. Do not create or alter numerical prices, confidence intervals, or BUY/SELL/HOLD decisions.
Do not claim this fictional market represents a real exchange. Return only the requested JSON schema.

EVIDENCE:\n{json.dumps(evidence, indent=2)}
"""
        try:
            response = self.client.responses.create(
                model=self.model,
                input=prompt,
                text={"format": {"type": "json_schema", "name": "market_intelligence", "strict": True, "schema": MARKET_INTELLIGENCE_SCHEMA}},
            )
            result = validate_market_intelligence(json.loads(response.output_text))
        except Exception as error:
            write_model_run(run_id=run_id, status="FAILED", model=self.model, base_url=self.base_url,
                            duration_ms=round((time.monotonic() - started_at) * 1000), model_input=evidence,
                            error={"type": type(error).__name__, "message": str(error)})
            raise
        write_model_run(run_id=run_id, status="COMPLETED", model=self.model, base_url=self.base_url,
                        duration_ms=round((time.monotonic() - started_at) * 1000), model_input=evidence, model_output=result)
        return result

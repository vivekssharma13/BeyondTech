from app.ai.provider import AiProvider
import json
import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

class OpenAIProvider(AiProvider):
    def __init__(self):
        apiKey=os.getenv("OPENAI_API_KEY")
        if not apiKey:
            raise ValueError("OPENAI_API_KEY is missing. Add it to your .env file.")
        self.client = OpenAI(api_key=apiKey)

    def analyze(self, scraped_data):

        prompt = f"""
You are the Market Agent for a renewable energy orchestration system.

Your job is to analyze external energy-market observations and determine
their likely implications for renewable generation, electricity prices,
demand, grid conditions and battery requirements.

IMPORTANT:
- The input contains observations collected by a web scraper.
- Do not assume the scraper has already interpreted the data.
- You must perform the market reasoning yourself.
- Consider both solar and wind generation.
- Consider electricity price changes.
- Consider demand and demand forecast.
- Consider battery state of charge.
- Consider grid frequency and transmission constraints.
- Consider relevant external signals/news.
- Do not invent facts that are not present in the input.

Return ONLY valid JSON.

Required structure:

{{
    "market_status": "FAVORABLE | UNFAVORABLE | NEUTRAL",
    "news_impact": "LOW | MEDIUM | HIGH",
    "battery_recommendation": "HOLD_RESERVE | NORMAL_OPERATION | INCREASE_DISCHARGE",
    "risk_level": "LOW | MEDIUM | HIGH",
    "confidence": 0,
    "reasoning": "Explain the reasoning based only on the supplied observations."
}}

SCRAPER OBSERVATIONS:

{json.dumps(scraped_data, indent=2)}
"""

        response = self.client.responses.create(
            model="gpt-5-mini",
            input=prompt
        )

        return json.loads(response.output_text)
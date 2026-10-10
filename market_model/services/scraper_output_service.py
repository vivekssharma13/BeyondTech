import json
from pathlib import Path

OUTPUT_FILE = Path(__file__).resolve().parents[1] / "output" / "simulatedWorld.json"

class ScraperOutputService:

    def load(self):
        with OUTPUT_FILE.open("r", encoding="utf-8") as file:
            return json.load(file)

import json

class ScraperOutputService:

    def load(self):
        with open(
            "output/simulatedWorld.json",
            "r",
            encoding="utf-8"
        ) as file:
            return json.load(file)
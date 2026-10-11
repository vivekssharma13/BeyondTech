from ai.openai_provider import OpenAIProvider
from services.scraper_output_service import ScraperOutputService

class MarketAgent:
    def __init__(self, openai_provider=None, scraper_service=None):
        self.openai_provider = openai_provider or OpenAIProvider()
        self.scraper_service = scraper_service or ScraperOutputService()

    def run(self, supplied_evidence=None):
        scraped_data = supplied_evidence if supplied_evidence is not None else self.scraper_service.load()
        results = scraped_data.get("results") if isinstance(scraped_data, dict) else None
        if isinstance(results, list):
            seen = set()
            unique = []
            for item in results:
                fingerprint = " ".join(str(item.get(key, "")).lower().split() for key in ("title", "description", "text"))
                if fingerprint and fingerprint in seen:
                    continue
                seen.add(fingerprint)
                unique.append(item)
            scraped_data = {**scraped_data, "results": unique, "total_results": len(unique)}
        return self.openai_provider.analyze(scraped_data)

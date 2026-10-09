from openai import OpenAI
import json
from app.services.news_service import NewsService
from app.ai.openai_provider import OpenAIProvider
from app.services.scraper_output_service import ScraperOutputService

class MarketAgent:
    def __init__(self):
        # self.news_service= NewsService()
        self.openai_provider=OpenAIProvider()
        self.scraper_service = ScraperOutputService()

    def run(self):

        # 1. Get raw observations from the scraper
        scraped_data = self.scraper_service.load()

        # 2. Send those observations to the AI for market analysis
        result = self.openai_provider.analyze(scraped_data)

        return result
    
#     def analyze(self):
#         articles=self.news_service.getRelevantNews()
#         news_text=""
#         for index,article in enumerate(articles, index=1):
#             news_text +=f"""
# ARTICLE{index}
# Title:
# {article["title"]}

# Summary:
# {article["summary"]}

# Published:
# {article["published"]}

# URL:
# {article["link"]}

# -------------------------
# """
#         result= self.openai_provider.analyze(self, news_text)
#         return result

    # def analyze(
    #         self,
    #         electricty_price,
    #         demand_mw,
    #         battery_soc
    # ):
    #     return {
    #         "electricity_price": electricty_price,
    #         "demand_mw": demand_mw,
    #         "battery_soc": battery_soc
    #     }
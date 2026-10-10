"""Legacy prototype; not used by the active Market Agent or decision pipeline."""

class PriceService:

    def get_current_price(self):

        return {
            "price": 8.42,
            "currency": "INR",
            "unit": "kWh",
            "timestamp": "2026-09-25T21:30:00Z"
        }
    
    def determine_price_trend(price):
        if price >= 10:
            return "HIGH"

        if price >= 7:
            return "MEDIUM"

        return "LOW"

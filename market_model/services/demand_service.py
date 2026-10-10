"""Legacy prototype; not used by the active Market Agent or decision pipeline."""

class DemandService:
    def get_current_demand(self):
        return {
            "demand_mw": 124,
            "trend":"INCREASING",
            "timestamp": "2026-09-25T21:30:00Z"
        }
    
    def determine_demand_risk(demand):
        if demand >= 130:
            return "HIGH"

        if demand >= 110:
            return "MEDIUM"

        return "LOW"

class BatteryService:
    def get_battery_status(self):

        return {
            "soc_percent": 82,
            "capacity_mwh": 100,
            "max_charge_mw": 20,
            "max_discharge_mw": 20
        }
    
    def determine_battery_requirement(demand,price,battery_soc):
        if demand >= 130 and battery_soc < 40:
            return {
                "reserve": 20,
                "action": "PRESERVE_BATTERY"
            }

        if price >= 10:
            return {
                "reserve": 30,
                "action": "HOLD_RESERVE"
            }

        return {
            "reserve": 15,
            "action": "NORMAL_OPERATION"
        }
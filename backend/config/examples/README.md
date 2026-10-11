# Phase 2A demonstration profile

`phase2a_demo_profile.js` contains fictional locations and equipment assumptions
for the four existing simulation farms. Every value is persisted with
`USER_CONFIGURED_SIMULATION` provenance. None is verified operational data.

The profile is inactive by default. Activate it explicitly from `backend/`:

```bash
npm run config:activate-phase2a-demo
```

This creates a new immutable configuration version in the configured SQLite
database. Review and replace the values through the versioned configuration
workflow when different simulation assumptions are required.

## Integrated demonstration profile

`integrated_demo_profile.js` adds explicitly fictional market, economic,
portfolio-strategy, and AI budget assumptions. It includes Normal Market, High
Demand, Renewable Surplus, and Volatile Market scenarios and activates only
Normal Market.

```bash
npm run config:activate-integrated-demo
```

This command also activates the Phase 2A farm profile in a new immutable
configuration version. It is never run automatically; review every value first.

import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity, AlertTriangle, BatteryCharging, Bell, Bot, BrainCircuit, Check, ChevronRight, CircleGauge, CloudSun, Compass, Gauge, Grid3X3, Leaf, Menu, Moon, MoreHorizontal, PanelLeftClose, Settings2, Sun, SunMedium, TrendingUp, Wind, X, Zap } from 'lucide-react'
import { energyService } from './services/energyService'
import './App.css'

const DashboardContext = createContext(null)
const FarmExplorerPage = lazy(() => import('./FarmExplorer/FarmExplorerPage.jsx'))
function useDashboardData() { return useContext(DashboardContext) }
function DashboardDataProvider({ children }) {
  const [state, setState] = useState({ loading: true, error: '', data: null })
  const [refreshToken, setRefreshToken] = useState(0)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [fleet, farms, performance, alerts, agentRuns, marketForecast, freshness, health] = await Promise.all([energyService.getFleet(), energyService.getFarms(), energyService.getPerformance(), energyService.getAlerts(), energyService.getAgentRuns(), energyService.getMarketForecast(), energyService.getFreshness(), energyService.getHealth()])
        const forecasts = Object.fromEntries(await Promise.all(farms.map(async (farm) => [farm.id, await energyService.getForecast(farm.id)])))
        if (active) setState({ loading: false, error: '', data: { fleet, farms, forecasts, forecast: forecasts.sunpeak || Object.values(forecasts)[0], performance, alerts, agentRuns, marketForecast, freshness, health } })
      } catch (error) {
        if (active) setState((current) => current.data ? { ...current, error: error.message } : { loading: false, error: error.message, data: null })
      }
    }
    load()
    const id = setInterval(load, 45000)
    return () => { active = false; clearInterval(id) }
  }, [refreshToken])
  if (state.loading) return <div className="app-loading">Loading control-room data…</div>
  if (state.error) return <div className="app-loading error"><AlertTriangle size={18} /> Dashboard API unavailable: {state.error}</div>
  return <DashboardContext.Provider value={{ ...state.data, refresh: () => setRefreshToken((value) => value + 1) }}>{children}</DashboardContext.Provider>
}

const navItems = [
  { label: 'Fleet Overview', path: '/', icon: Grid3X3 },
  { label: '3D Farm Explorer', path: '/farm-explorer', icon: Compass },
  { label: 'Farm Detail', path: '/farm', icon: CircleGauge },
  { label: 'Forecast & AI', path: '/forecast', icon: BrainCircuit },
  { label: 'Performance', path: '/performance', icon: Activity },
  { label: 'Operations', path: '/operations', icon: Settings2 },
  { label: 'Alerts', path: '/alerts', icon: Bell },
]
const number = (value) => new Intl.NumberFormat('en-IN').format(value)
const currency = (value) => `₹${(value / 1000).toFixed(1)}k`
const istTime = (value) => value ? new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'N/A'
const relativeTime = (value) => { if (!value) return 'not run'; const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago` }
function SourceBadge({ source }) { return <span className="simulated-label">{source || 'UNKNOWN'}</span> }

function StatusBadge({ status }) { return <span className={`status-badge ${status}`}><span className="status-dot" />{status}</span> }
function Card({ children, className = '' }) { return <section className={`card ${className}`}>{children}</section> }
function SectionHeader({ eyebrow, title, action }) { return <div className="section-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action}</div> }
function KpiCard({ label, value, detail, tone = '', icon: Icon, trend }) { return <div className={`kpi-card ${tone}`}><div className="kpi-top"><span>{label}</span>{Icon && <Icon size={16} />}</div><strong>{value}</strong>{detail && <small className={trend?.startsWith('-') ? 'negative' : 'positive'}>{detail}</small>}</div> }
function MetricRow({ label, value, accent }) { return <div className="metric-row"><span>{label}</span><strong className={accent || ''}>{value}</strong></div> }
function ProgressBar({ value, color = 'cyan' }) { return <div className="progress-track"><span className={`progress-fill ${color}`} style={{ width: `${Math.min(value, 100)}%` }} /></div> }
function ChartCard({ title, subtitle, children, action }) { return <Card className="chart-card"><div className="card-heading"><div><h3>{title}</h3>{subtitle && <span>{subtitle}</span>}</div>{action}</div>{children}</Card> }

function FleetChart({ height = 300, data }) {
  const { forecast } = useDashboardData()
  const generationSeries = data || forecast.series
  return <div className="chart-wrap"><ResponsiveContainer width="100%" height={height}><AreaChart data={generationSeries} margin={{ top: 8, right: 10, left: -20, bottom: 0 }}><defs><linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#30d5c8" stopOpacity={0.28} /><stop offset="100%" stopColor="#30d5c8" stopOpacity={0} /></linearGradient><linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8e7cff" stopOpacity={0.18} /><stop offset="100%" stopColor="#8e7cff" stopOpacity={0} /></linearGradient></defs><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} unit=" MW" /><Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)' }} /><Area type="monotone" dataKey="actual" stroke="#30d5c8" strokeWidth={2.5} fill="url(#actualFill)" /><Area type="monotone" dataKey="forecast" stroke="#8e7cff" strokeWidth={2} strokeDasharray="5 5" fill="url(#forecastFill)" /></AreaChart></ResponsiveContainer><div className="chart-legend"><span><i className="legend-line actual" /> Actual generation</span><span><i className="legend-line forecast" /> Latest forecast</span><span className="chart-now">NOW</span></div></div>
}

function FarmSelector({ selectedFarm, setSelectedFarm }) { const { farms } = useDashboardData(); return <select className="farm-select" value={selectedFarm} onChange={(event) => setSelectedFarm(event.target.value)}>{farms.map((farm) => <option value={farm.id} key={farm.id}>{farm.name}</option>)}</select> }
function InsightRow({ icon, text, meta }) { return <div className="insight-row"><span className="insight-icon">{icon}</span><div><p>{text}</p><small>{meta}</small></div></div> }

function Sidebar() {
  const { alerts, health } = useDashboardData()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  return <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}><div className="brand"><span className="brand-mark"><Leaf size={18} /></span><span>GRIDLINE <b>AI</b></span><button className="collapse-button" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <Menu size={17} /> : <PanelLeftClose size={17} />}</button></div><div className="sidebar-label">Workspace</div><nav>{navItems.map(({ label, path, icon: Icon }) => <NavLink key={path} to={path} className={({ isActive }) => `nav-link ${isActive || (path === '/farm' && location.pathname.startsWith('/farm/')) ? 'active' : ''}`}><Icon size={17} /><span>{label}</span>{label === 'Alerts' && <em>{alerts.filter((item) => !item.acknowledged).length}</em>}</NavLink>)}</nav><div className="sidebar-footer"><div className="agent-status"><span className="pulse" /><div><strong>Forecast model</strong><span>{health.components.generationModel.status}</span></div></div><div className="version">Demo environment · simulated telemetry</div></div></aside>
}

function Topbar({ selectedFarm, setSelectedFarm, theme, setTheme }) {
  const { freshness, agentRuns } = useDashboardData()
  const [time, setTime] = useState(() => istTime(Date.now()))
  useEffect(() => { const id = setInterval(() => setTime(istTime(Date.now())), 1000); return () => clearInterval(id) }, [])
  const latestRun = agentRuns[0]
  return <header className="topbar"><div className="mobile-brand"><Leaf size={18} /> Gridline AI</div><div className="topbar-context"><FarmSelector selectedFarm={selectedFarm} setSelectedFarm={setSelectedFarm} /><span className="divider" /><span className="live-clock"><span className="live-dot" /> {time} IST · Simulated</span></div><div className="topbar-meta"><span className="freshness"><span className="status-dot healthy" /> Telemetry <b>{relativeTime(freshness.telemetry.updatedAt)}</b></span><span className="agent-run"><Bot size={15} /> {latestRun?.agentRunId || 'No run'} <b>{istTime(latestRun?.generatedAt)}</b></span><button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme">{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button></div></header>
}
function AppShell({ children, ...props }) { return <div className="app-shell"><Sidebar /><div className="main-shell"><Topbar {...props} /><main className="page-content">{children}</main></div></div> }

function FarmCard({ farm, onSelect }) {
  const Icon = farm.type === 'solar' ? SunMedium : Wind
  return <button className="farm-card" onClick={() => onSelect(farm.id)}><div className="farm-card-head"><div className={`farm-icon ${farm.type}`}><Icon size={17} /></div><div className="farm-title"><strong>{farm.name}</strong><span>{farm.type} · {farm.capacityMW} MW</span></div><StatusBadge status={farm.status} /></div><div className="farm-output"><strong>{farm.currentGenerationMW}<small> MW</small></strong><span>current generation</span><ChevronRight size={16} /></div><div className="farm-card-grid"><div><span>Forecast</span><strong>{farm.forecastGenerationMW} MW</strong></div><div><span>Availability</span><strong>{farm.availabilityPct}%</strong></div><div><span>Battery</span><strong>{farm.batterySocPct}%</strong></div><div><span>Headroom</span><strong>{(farm.gridExportLimitMW - farm.currentExportMW).toFixed(1)} MW</strong></div></div><div className="mini-bars">{[34, 51, 46, 62, 58, 72, 66, 78, 70, 82].map((height, index) => <i key={index} style={{ height: `${Math.max(15, height * (farm.currentGenerationMW / farm.capacityMW))}%` }} />)}</div></button>
}

function MarketCardContents() { const { marketForecast } = useDashboardData(); return <Card className="market-card"><div className="card-heading"><div><span className="eyebrow">MARKET INTELLIGENCE</span><h3>Price signal</h3></div><span><SourceBadge source={marketForecast.source} /> <span className="market-badge"><TrendingUp size={13} /> {marketForecast.trend}</span></span></div><div className="market-price"><strong>₹{number(marketForecast.current)}</strong><span>/ MWh · current</span></div><div className="market-grid"><div><span>1h</span><strong>₹{number(marketForecast.oneHour)}</strong></div><div><span>6h</span><strong>₹{number(marketForecast.sixHour)}</strong></div><div><span>24h</span><strong>₹{number(marketForecast.day)}</strong></div></div><p>Peak expected at <b>{marketForecast.peakTime}</b> · ₹{number(marketForecast.peak)}/MWh</p><small><Bot size={13} /> Market confidence {marketForecast.confidence}% · updated {relativeTime(marketForecast.generatedAt)} · no dispatch decisions</small></Card> }
function MarketCard() { return <MarketCardContents /> }

function FleetOverview({ onFarmSelect }) {
  const { farms, fleet, forecasts, health } = useDashboardData()
  const [clock, setClock] = useState(() => Date.now())
  const [chartRange, setChartRange] = useState('12h')
  const [chartData, setChartData] = useState([])
  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    let active = true
    Promise.all(farms.map((farm) => energyService.getForecast(farm.id, chartRange))).then((items) => {
      if (!active) return
      setChartData(items[0].series.map((point, index) => ({ label: point.label, actual: items.reduce((sum, item) => sum + (item.series[index]?.actual || 0), 0), forecast: items.reduce((sum, item) => sum + (item.series[index]?.forecast || 0), 0) })))
    })
    return () => { active = false }
  }, [farms, chartRange])
  const totals = farms.reduce((acc, farm) => ({ generation: acc.generation + farm.currentGenerationMW, forecast: acc.forecast + (forecasts[farm.id]?.horizons.find((item) => item.horizon === '6h')?.value || 0), capacity: acc.capacity + farm.capacityMW, export: acc.export + farm.currentExportMW, limit: acc.limit + farm.gridExportLimitMW, revenue: acc.revenue + farm.revenueToday }), { generation: 0, forecast: 0, capacity: 0, export: 0, limit: 0, revenue: 0 })
  const currentGeneration = Number.isFinite(fleet.liveGenerationMW) ? fleet.liveGenerationMW : totals.generation
  const variancePct = totals.forecast ? (currentGeneration - totals.forecast) / totals.forecast * 100 : null
  const nextRunAt = Object.values(forecasts).map((item) => item.metadata.nextRunAt).filter(Boolean).sort()[0]
  const batteryPower = farms.reduce((sum, farm) => sum + farm.batteryPowerMW, 0)
  const changeFor = (type) => { const selected = farms.filter((farm) => farm.type === type); const current = selected.reduce((sum, farm) => sum + farm.currentGenerationMW, 0); const future = selected.reduce((sum, farm) => sum + (forecasts[farm.id]?.horizons.find((item) => item.horizon === '6h')?.value || 0), 0); return current ? (future - current) / current * 100 : null }
  const solarChange = changeFor('solar')
  const windChange = changeFor('wind')
  const headroomPct = totals.limit ? (totals.limit - totals.export) / totals.limit * 100 : null
  const solar = farms.filter((farm) => farm.type === 'solar').reduce((sum, farm) => sum + farm.currentGenerationMW, 0)
  const wind = currentGeneration - solar
  return <div className="page-stack"><SectionHeader eyebrow="FLEET OVERVIEW" title="AI Generation Intelligence" action={<div className="header-actions"><span className="agent-chip"><Bot size={15} /> {health.components.generationModel.status}</span></div>} /><div className="hero-strip"><div><span className="eyebrow">SIMULATED FLEET TELEMETRY</span><h1>Fleet generation is <span>{variancePct == null ? "awaiting forecast" : variancePct >= 0 ? "above forecast" : "below forecast"}</span>.</h1><p>Current telemetry is simulated; the comparison uses the latest per-farm model forecasts.</p></div><div className="hero-status"><span>Next agent run</span><strong>{istTime(nextRunAt)}</strong><small>{nextRunAt ? `in ${Math.max(0, Math.ceil((new Date(nextRunAt).getTime() - clock) / 60000))} min · every 15 min` : 'Awaiting first model run'}</small></div></div><div className="kpi-grid"><KpiCard label="Current simulated generation" value={`${currentGeneration.toFixed(1)} MW`} detail={`Sum of ${fleet.generationByFarm?.length || farms.length} farm readings`} icon={Zap} trend={variancePct == null ? '' : String(variancePct)} /><KpiCard label="Forecast generation" value={`${totals.forecast.toFixed(1)} MW`} detail="Sum of farm 6h model forecasts" icon={BrainCircuit} tone="purple" /><KpiCard label="Installed capacity" value={`${totals.capacity} MW`} detail={`${farms.length} operating farms`} icon={Gauge} /><KpiCard label="Fleet utilization" value={`${((currentGeneration / totals.capacity) * 100).toFixed(1)}%`} detail="Current generation / capacity" icon={Activity} /><KpiCard label="Grid export" value={`${totals.export.toFixed(1)} MW`} detail={`${(totals.limit - totals.export).toFixed(1)} MW headroom`} icon={Grid3X3} /><KpiCard label="Revenue today" value={currency(totals.revenue)} detail="Simulated accumulated revenue" icon={TrendingUp} /></div><div className="two-column wide-chart"><ChartCard title="Fleet Generation — Actual vs Forecast" subtitle="Last 6 hours + next 6 hours · MW" action={<div className="segmented">{["12h", "24h", "72h"].map((range) => <button key={range} className={chartRange === range ? "active" : ""} onClick={() => setChartRange(range)}>{range.toUpperCase()}</button>)}</div>}><FleetChart data={chartData} /></ChartCard><Card className="grid-storage"><div className="card-heading"><div><span className="eyebrow">SYSTEM BALANCE</span><h3>Grid & Storage</h3></div><StatusBadge status="healthy" /></div><div className="balance-ring"><div><strong>{(totals.limit - totals.export).toFixed(0)}</strong><span>MW headroom</span></div></div><MetricRow label="Current generation" value={`${currentGeneration.toFixed(1)} MW`} /><MetricRow label="Grid export / limit" value={`${totals.export.toFixed(1)} / ${totals.limit} MW`} /><MetricRow label="Battery SOC" value={`${fleet.storage.socPct}%`} accent="cyan-text" /><ProgressBar value={fleet.storage.socPct} /><MetricRow label="Reserve target" value={`${fleet.storage.reservePct}%`} /><div className="charge-state"><BatteryCharging size={15} /><span>{batteryPower > 0 ? 'Battery discharging' : batteryPower < 0 ? 'Battery charging' : 'Battery idle'}</span><b>{batteryPower.toFixed(1)} MW</b></div></Card></div><div className="three-column"><Card className="contribution-card"><div className="card-heading"><div><span className="eyebrow">MIX</span><h3>Solar vs wind</h3></div></div><div className="donut-wrap"><ResponsiveContainer width="55%" height={150}><PieChart><Pie data={[{ name: 'Solar', value: solar }, { name: 'Wind', value: wind }]} dataKey="value" innerRadius={45} outerRadius={64} paddingAngle={4}><Cell fill="#f5c84b" /><Cell fill="#30d5c8" /></Pie><Tooltip /></PieChart></ResponsiveContainer><div className="donut-key"><span><i className="solar-dot" /> Solar <b>{solar.toFixed(0)} MW</b></span><span><i className="wind-dot" /> Wind <b>{wind.toFixed(0)} MW</b></span></div></div></Card><Card className="insight-card"><div className="card-heading"><div><span className="eyebrow">AI FLEET INSIGHTS</span><h3>What the agent sees</h3></div><Link to="/forecast" className="text-link">View all <ChevronRight size={14} /></Link></div><InsightRow icon={<CloudSun />} text={solarChange == null ? "Solar forecast unavailable." : `Solar output is forecast to ${solarChange >= 0 ? "increase" : "decrease"} ${Math.abs(solarChange).toFixed(1)}% over 6h.`} meta="Aggregated farm forecasts" /><InsightRow icon={<Wind />} text={windChange == null ? "Wind forecast unavailable." : `Wind output is forecast to ${windChange >= 0 ? "increase" : "decrease"} ${Math.abs(windChange).toFixed(1)}% over 6h.`} meta="Aggregated farm forecasts" /><InsightRow icon={<Grid3X3 />} text={headroomPct == null ? "Grid headroom unavailable." : `Fleet export headroom is ${headroomPct.toFixed(1)}% of the configured limit.`} meta="Simulated operational state" /></Card><MarketCard /></div><div><SectionHeader eyebrow="ASSET MONITOR" title="Farm fleet" action={<Link to="/farm" className="text-link">Open farm detail <ChevronRight size={14} /></Link>} /><div className="farm-grid">{farms.map((farm) => <FarmCard farm={farm} onSelect={onFarmSelect} key={farm.id} />)}</div></div></div>
}

function FarmDetail({ selectedFarm, setSelectedFarm }) {
  const { farms, forecasts, alerts, freshness } = useDashboardData()
  const farm = farms.find((item) => item.id === selectedFarm)
  if (!farm) return <div className="app-loading">Select a farm to view farm-specific telemetry.</div>
  const selectedForecast = forecasts[farm.id]
  const headroomRatio = (farm.gridExportLimitMW - farm.currentExportMW) / Math.max(farm.gridExportLimitMW, 1)
  const gridStatus = farm.currentExportMW >= farm.gridExportLimitMW ? 'critical' : headroomRatio < 0.2 ? 'warning' : 'healthy'
  const farmAlerts = alerts.filter((alert) => alert.farm === farm.name && !alert.acknowledged)
  const isSolar = farm.type === 'solar'
  const weatherValues = isSolar ? [['GHI', `${farm.weather.ghi} W/m²`], ['DNI', `${farm.weather.dni} W/m²`], ['DHI', `${farm.weather.dhi} W/m²`], ['Sunshine', `${farm.weather.sunshine}%`], ['Cloud cover', `${farm.weather.cloud}%`], ['Ambient temp', `${farm.weather.temp} °C`], ['Module temp', `${farm.weather.module} °C`], ['UV index', farm.weather.uv]] : [['Wind speed', `${farm.weather.wind} m/s`], ['Direction', `${farm.weather.direction}°`], ['Gusts', `${farm.weather.gust} m/s`], ['Air temperature', `${farm.weather.air} °C`], ['Air density', `${farm.weather.density} kg/m³`], ['Turbine availability', `${farm.weather.turbineAvailability}%`], ['Turbines online', `${farm.weather.online}/${farm.weather.total}`], ['Capacity factor', `${farm.weather.capacityFactor}%`]]
  return <div className="page-stack"><SectionHeader eyebrow="FARM DETAIL" title={farm.name} action={<FarmSelector selectedFarm={farm.id} setSelectedFarm={setSelectedFarm} />} /><div className="farm-detail-hero"><div className={`large-farm-icon ${farm.type}`}>{isSolar ? <SunMedium size={26} /> : <Wind size={26} />}</div><div><div className="title-row"><h1>{farm.name}</h1><StatusBadge status={farm.status} /></div><p>{isSolar ? 'Solar generation asset' : 'Wind generation asset'} · {farm.capacityMW} MW installed</p></div><div className="detail-current"><span>Current generation</span><strong>{farm.currentGenerationMW} <small>MW</small></strong><span>{((farm.currentGenerationMW / farm.capacityMW) * 100).toFixed(1)}% utilization</span></div></div><div className="kpi-grid five"><KpiCard label="Forecast" value={`${selectedForecast?.horizons.find((item) => item.horizon === '6h')?.value ?? 'N/A'} MW`} detail="next 6h avg" tone="purple" /><KpiCard label="Availability" value={`${farm.availabilityPct}%`} detail={`${farm.equipment.online}/${farm.equipment.total} online`} /><KpiCard label="Grid export" value={`${farm.currentExportMW} MW`} detail={`${(farm.gridExportLimitMW - farm.currentExportMW).toFixed(1)} MW headroom`} /><KpiCard label="Battery SOC" value={`${farm.batterySocPct}%`} detail={`${farm.batteryCapacityMWh} MWh capacity`} icon={BatteryCharging} /><KpiCard label="Revenue today" value={currency(farm.revenueToday)} detail="Simulated accumulated revenue" /></div><div className="two-column detail-columns"><ChartCard title="Generation performance" subtitle="Actual vs forecast · last 24 hours"><FleetChart data={selectedForecast?.series} /></ChartCard><Card><div className="card-heading"><div><span className="eyebrow">SIMULATED CONDITIONS</span><h3>Weather telemetry</h3></div><span className="data-time"><SourceBadge source="SIMULATED" /> {relativeTime(freshness.weather.updatedAt)}</span></div><div className="weather-grid">{weatherValues.map(([label, value]) => <MetricRow key={label} label={label} value={value} />)}</div></Card></div><div className="three-column"><Card><div className="card-heading"><h3>Grid connection</h3><StatusBadge status={gridStatus} /></div><MetricRow label="Current export" value={`${farm.currentExportMW} MW`} /><MetricRow label="Export limit" value={`${farm.gridExportLimitMW} MW`} /><MetricRow label="Headroom" value={`${(farm.gridExportLimitMW - farm.currentExportMW).toFixed(1)} MW`} accent="cyan-text" /><MetricRow label="Curtailed power" value={`${farm.curtailmentMW} MW`} /></Card><Card><div className="card-heading"><h3>Storage state</h3><BatteryCharging size={17} /></div><MetricRow label="State of charge" value={`${farm.batterySocPct}%`} /><ProgressBar value={farm.batterySocPct} color="green" /><MetricRow label="State of health" value={`${farm.batterySohPct}%`} /><MetricRow label="Charge / discharge" value={`${farm.batteryPowerMW > 0 ? '+' : ''}${farm.batteryPowerMW} MW`} /><MetricRow label="Reserve target" value={`${farm.reservePct}%`} /></Card><Card><div className="card-heading"><h3>Farm status</h3><StatusBadge status={farm.status} /></div><div className="equipment-stat"><div className="equipment-number">{farm.equipment.online}<span>/{farm.equipment.total}</span></div><div><strong>{isSolar ? 'Inverters' : 'Turbines'} online</strong><p>Availability {farm.availabilityPct}%</p></div></div><div className="mini-status-line"><span className={`status-dot ${farmAlerts.length ? "warning" : "healthy"}`} /> {farmAlerts.length ? `${farmAlerts.length} active farm alert${farmAlerts.length === 1 ? "" : "s"}` : "No active threshold alerts"}</div></Card></div></div>
}

function ForecastAI({ selectedFarm }) { const { forecasts, agentRuns, performance } = useDashboardData(); const forecast = forecasts[selectedFarm]; if (!forecast) return <div className="app-loading">Select a farm to view its forecast.</div>; const forecastHorizons = forecast.horizons; return <div className="page-stack"><SectionHeader eyebrow="FORECAST & AI" title="Forecast intelligence" action={<span className="agent-chip"><Bot size={15} /> {forecast.metadata.agentRunId} · {istTime(forecast.metadata.generatedAt)}</span>} /><div className="horizon-grid">{forecastHorizons.map((item, index) => <div className={`horizon-card ${index === 1 ? 'selected' : ''}`} key={item.label}><span>{item.label}</span><strong>{item.value} <small>MW avg</small></strong><b className={item.change < 0 ? 'negative' : 'positive'}>{item.change < 0 ? '↓' : '↑'} {Math.abs(item.change)}%</b><div className="horizon-range">{item.range}</div><div className="confidence"><span>Confidence</span><strong>{item.confidence}%</strong></div><ProgressBar value={item.confidence} color={item.confidence < 70 ? 'amber' : 'purple'} /></div>)}</div><div className="two-column forecast-main"><ChartCard title="Latest forecast revision" subtitle="Actual + latest forecast + previous agent run"><FleetChart data={forecast.series} /></ChartCard><Card className="reasoning-card"><div className="agent-heading"><span className="ai-orb"><Bot size={19} /></span><div><span className="eyebrow">GENERATION FORECAST AGENT</span><h3>Reasoning summary</h3></div><span className="completed"><Check size={14} /> Complete</span></div><div className="prediction-callout"><span>Prediction</span><strong>{forecast.metadata.drivers?.[0] || 'No model driver supplied.'}</strong><div><span>Confidence</span><b>{forecast.horizons.find((item) => item.horizon === '6h')?.confidence ?? 'N/A'}%</b></div></div><h4>Main drivers</h4><ul className="driver-list">{forecast.metadata.drivers.map((driver) => <li key={driver}><span className="driver-neutral">→</span>{driver}</li>)}</ul><h4>Data considered</h4><div className="data-pills"><SourceBadge source={forecast.metadata.source} /><span>{forecast.metadata.weatherInputSource || 'Input source unavailable'}</span></div></Card></div><div className="two-column"><Card><div className="card-heading"><div><span className="eyebrow">FORECAST CHANGE</span><h3>What changed since previous run?</h3></div><span className="revision negative">{forecast.horizons.find((item) => item.horizon === '6h')?.change == null ? 'N/A' : `${forecast.horizons.find((item) => item.horizon === '6h').change}%`}</span></div><div className="compare-values"><div><span>Previous 6h forecast</span><strong>{forecast.metadata.previousAgentRunId ? 'See prior run' : 'N/A'}</strong></div><ChevronRight size={17} /><div><span>Current 6h forecast</span><strong>{forecast.horizons.find((item) => item.horizon === '6h')?.value ?? 'N/A'} MW</strong></div></div><p className="reason-text">{forecast.metadata.previousAgentRunId ? 'Change calculated against the previous successful run.' : 'No previous in-process model run is available for comparison.'}</p></Card><MarketCard /></div><div className="two-column"><Card><div className="card-heading"><div><span className="eyebrow">FORECAST ACCURACY</span><h3>Model performance</h3></div></div><div className="accuracy-grid"><MetricRow label="Forecast accuracy" value={performance.accuracy == null ? "N/A — actual outcome not recorded" : `${performance.accuracy}%`} /></div></Card><Card><div className="card-heading"><div><span className="eyebrow">AGENT TIMELINE</span><h3>Recent runs</h3></div></div><div className="timeline">{agentRuns.filter((run) => run.agent === 'GENERATION_FORECAST' && run.farmId === selectedFarm).slice(0, 4).map((run, index) => <div className={index === 0 ? 'selected' : ''} key={run.agentRunId}><span className="timeline-dot" /><strong>{istTime(run.generatedAt)}</strong><span>{run.source}</span></div>)}</div></Card></div></div> }

function Performance() { const { farms, forecast, performance: initialPerformance } = useDashboardData(); const [range, setRange] = useState('today'); const [performance, setPerformance] = useState(initialPerformance); useEffect(() => { let active = true; energyService.getPerformance(range).then((result) => { if (active) setPerformance(result) }); return () => { active = false } }, [range]); const data = forecast.series.map((item) => ({ month: item.label, actual: item.actual, expected: item.forecast })); return <div className="page-stack"><SectionHeader eyebrow="PERFORMANCE" title="Energy & business value" action={<div className="segmented">{["today", "7d", "30d", "ytd"].map((item) => <button key={item} className={range === item ? "active" : ""} onClick={() => setRange(item)}>{item.toUpperCase()}</button>)}</div>} /><div className="kpi-grid five"><KpiCard label="Energy generated" value={`${number(performance.energy)} MWh`} detail={performance.expected ? `${((performance.energy - performance.expected) / performance.expected * 100).toFixed(1)}% vs expected` : "Expected unavailable"} /><KpiCard label="Expected energy" value={`${number(performance.expected)} MWh`} detail="forecast baseline" /><KpiCard label="Capacity factor" value={`${performance.capacityFactor}%`} detail="fleet weighted" /><KpiCard label="Availability" value={`${performance.availability}%`} detail="Capacity-weighted simulated availability" /><KpiCard label="Revenue" value={currency(performance.revenue)} detail="Simulated accumulated revenue" /></div><div className="two-column"><ChartCard title="Actual vs expected generation" subtitle="Backend generation history · MW"><ResponsiveContainer width="100%" height={300}><BarChart data={data} margin={{ left: -20, right: 10 }}><CartesianGrid stroke="var(--chart-grid)" vertical={false} /><XAxis dataKey="month" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: 'var(--tooltip-bg)', border: '1px solid var(--line)' }} /><Bar dataKey="expected" fill="#596579" radius={[3, 3, 0, 0]} /><Bar dataKey="actual" fill="#30d5c8" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></ChartCard><Card><div className="card-heading"><div><span className="eyebrow">VALUE BREAKDOWN</span><h3>Energy sources</h3></div></div><div className="value-list"><MetricRow label="Solar energy" value={`${number(performance.solarEnergyMWh)} MWh`} /><ProgressBar value={performance.energy ? performance.solarEnergyMWh / performance.energy * 100 : 0} color="yellow" /><MetricRow label="Wind energy" value={`${number(performance.windEnergyMWh)} MWh`} /><ProgressBar value={performance.energy ? performance.windEnergyMWh / performance.energy * 100 : 0} color="cyan" /><MetricRow label="Battery discharged" value={`${number(performance.batteryDischargeMWh)} MWh`} /><ProgressBar value={22} color="purple" /><MetricRow label="Curtailed energy" value={`${performance.curtailed} MWh`} accent="amber-text" /></div><div className="lost-revenue"><span>Estimated lost revenue</span><strong>{currency(performance.lostRevenue)}</strong><small>{performance.lossReason || "No simulated loss"}</small></div></Card></div><Card><div className="card-heading"><div><span className="eyebrow">FARM PERFORMANCE</span><h3>Asset comparison</h3></div><button className="icon-button"><MoreHorizontal size={16} /></button></div><div className="table-scroll"><table><thead><tr><th>Farm</th><th>Type</th><th>Energy generated</th><th>Capacity factor</th><th>Availability</th><th>Forecast accuracy</th><th>Revenue</th><th>Status</th></tr></thead><tbody>{performance.farms.map((row) => { const farm = farms.find((item) => item.id === row.farmId); return <tr key={row.farmId}><td><strong>{row.name}</strong></td><td><span className={`type-label ${farm.type}`}>{farm.type}</span></td><td>{number(row.energyMWh)} MWh</td><td>{row.capacityFactorPct}%</td><td>{row.availabilityPct}%</td><td>{row.forecastAccuracyPct == null ? "N/A" : `${row.forecastAccuracyPct}%`}</td><td>{currency(row.revenue)}</td><td><StatusBadge status={farm.status} /></td></tr>})}</tbody></table></div></Card></div> }

function ControlSlider({ label, value, setValue, min, max, unit, helper }) { return <label className="control-label"><span>{label}<b>{value}{unit}</b></span><input type="range" min={min} max={max} value={value} onChange={(event) => setValue(Number(event.target.value))} /><small>{helper}</small></label> }
function Operations({ selectedFarm, setSelectedFarm }) {
  const { farms, marketForecast, refresh } = useDashboardData()
  const farm = farms.find((item) => item.id === selectedFarm) || farms[0]
  const [reserve, setReserve] = useState(farm.reservePct)
  const [exportLimit, setExportLimit] = useState(farm.gridExportLimitMW)
  const [mode, setMode] = useState(farm.batteryMode || 'AUTO')
  const [outputLimit, setOutputLimit] = useState(farm.outputLimitPct || 100)
  const [operatingMode, setOperatingMode] = useState(farm.operatingMode || 'AI_ASSISTED')
  const [review, setReview] = useState(false)
  const [decision, setDecision] = useState(null)
  const [activity, setActivity] = useState([])
  const [status, setStatus] = useState({ loading: true, message: '', error: '' })

  useEffect(() => {
    let active = true
    Promise.all([
      energyService.getDecisionRecommendation(farm.id),
      energyService.getOperations(farm.id),
    ]).then(async ([nextDecision, operations]) => {
      const nextActivity = await energyService.getActivity(farm.id)
      if (!active) return
      setDecision(nextDecision)
      setReserve(operations.reservePct)
      setExportLimit(operations.gridExportLimitMW)
      setMode(operations.batteryMode)
      setOutputLimit(operations.outputLimitPct)
      setOperatingMode(operations.operatingMode)
      setActivity(nextActivity)
      setStatus({ loading: false, message: '', error: '' })
    }).catch((error) => {
      if (active) setStatus({ loading: false, message: '', error: error.message })
    })
    return () => { active = false }
  }, [farm.id])

  const applyOperations = async () => {
    try {
      await energyService.updateOperations(farm.id, {
        reservePct: reserve,
        gridExportLimitMW: exportLimit,
        batteryMode: mode,
        outputLimitPct: outputLimit,
        operatingMode,
      })
      setReview(false)
      setStatus({ loading: false, message: 'Simulated operating settings applied.', error: '' })
      setActivity(await energyService.getActivity(farm.id))
      refresh()
    } catch (error) {
      setStatus({ loading: false, message: '', error: error.message })
    }
  }

  const actOnDecision = async (action) => {
    try {
      const result = await energyService.actOnDecision(decision.decisionId, action)
      setStatus({ loading: false, message: action === 'ACCEPT' ? 'Decision applied to simulated state.' : 'Decision dismissed.', error: '' })
      setActivity(await energyService.getActivity(farm.id))
      refresh()
      setDecision(null)
      return result
    } catch (error) {
      setStatus({ loading: false, message: '', error: error.message })
    }
  }

  return <div className="page-stack">
    <SectionHeader eyebrow="OPERATIONS" title="Simulated controls" action={<FarmSelector selectedFarm={selectedFarm} setSelectedFarm={setSelectedFarm} />} />
    <div className="simulation-banner"><Settings2 size={17} /><div><strong>Simulation mode</strong><span>Changes stay in this demo and are never sent to physical infrastructure.</span></div><StatusBadge status="healthy" /></div>
    {status.error && <div className="model-error"><AlertTriangle size={15} /> {status.error}</div>}
    {status.message && <div className="applied-note"><Check size={15} /> {status.message}</div>}
    <div className="two-column operations-grid">
      <div>
        <Card>
          <div className="card-heading"><div><span className="eyebrow">CURRENT STATE</span><h3>{farm.name}</h3></div><StatusBadge status={farm.status} /></div>
          <div className="state-grid">
            <MetricRow label="Generation" value={`${farm.currentGenerationMW} MW`} />
            <MetricRow label="Grid export" value={`${farm.currentExportMW} MW`} />
            <MetricRow label="Grid import / limit" value={`${farm.currentImportMW} / ${farm.gridImportLimitMW} MW`} />
            <MetricRow label="Export limit" value={`${exportLimit} MW`} />
            <MetricRow label="Export headroom" value={`${Math.max(0, exportLimit - farm.currentExportMW).toFixed(1)} MW`} accent="cyan-text" />
            <MetricRow label="Battery SOC / reserve" value={`${farm.batterySocPct}% / ${reserve}%`} />
            <MetricRow label="Market price" value={`₹${number(marketForecast.current)}/MWh`} />
          </div>
        </Card>
        <Card className="decision-card">
          <div className="card-heading"><div><span className="eyebrow">FINAL ENERGY DECISION</span><h3>{status.loading || decision?.farmId !== farm.id ? 'Calculating…' : decision?.decision || 'Unavailable'}</h3></div>{decision?.farmId === farm.id && <span className="recommendation-confidence">{decision.confidencePct}% confidence</span>}</div>
          {decision?.farmId === farm.id && <>
            <div className={`decision-hero ${decision.decision.toLowerCase()}`}><strong>{decision.decision}</strong><span>{decision.quantityMW} MW</span></div>
            <p className="decision-reason">{decision.reason}</p>
            <div className="decision-scores">{Object.entries(decision.scores).map(([action, score]) => <div key={action}><span>{action}<b>{score}</b></span><ProgressBar value={score} color={action === 'HOLD' ? 'amber' : action === 'BUY' ? 'purple' : 'green'} /></div>)}</div>
            <div className="decision-arguments"><strong>Why</strong>{decision.argumentsFor.map((argument) => <p key={argument}><span>+</span>{argument}</p>)}{decision.argumentsAgainst.map((argument) => <p className="against" key={argument}><span>−</span>{argument}</p>)}</div>
            <div className="pipeline-strip"><span>Generation forecast</span><i>+</i><span>Market forecast</span><i>→</i><span>Optimizer quantities</span><i>→</i><b>Decision Agent</b></div>
            <small className="decision-source">Source: SIMULATED rule-based Decision Agent · quantity supplied by Optimizer. Confidence is a deterministic decision score, not a calibrated probability.</small>
            <div className="recommendation-actions"><button className="primary-button" onClick={() => actOnDecision('ACCEPT')}><Check size={15} /> Accept</button><button className="text-button" onClick={() => actOnDecision('DISMISS')}>Dismiss</button></div>
          </>}
        </Card>
      </div>
      <div>
        <Card>
          <div className="card-heading"><div><span className="eyebrow">CONTROL PANEL</span><h3>Review operating settings</h3></div><span className="simulated-label">SIMULATED</span></div>
          <ControlSlider label="Battery reserve" value={reserve} setValue={setReserve} min={0} max={100} unit="%" helper="Minimum stored-energy target" />
          <label className="control-label">Grid export limit <span>MW</span><input type="number" min="0" max={farm.connectionExportCapacityMW} value={exportLimit} onChange={(event) => setExportLimit(Math.min(Number(event.target.value), farm.connectionExportCapacityMW))} /></label>
          <div className="control-label"><span>Battery mode</span><div className="mode-buttons">{['AUTO', 'CHARGE', 'DISCHARGE', 'IDLE'].map((item) => <button className={mode === item ? 'selected' : ''} key={item} onClick={() => setMode(item)}>{item}</button>)}</div></div>
          <div className="control-label"><span>Operating mode</span><div className="mode-buttons">{['AI_ASSISTED', 'MANUAL'].map((item) => <button className={operatingMode === item ? 'selected' : ''} key={item} onClick={() => setOperatingMode(item)}>{item}</button>)}</div></div>
          <ControlSlider label="Farm output limit" value={outputLimit} setValue={setOutputLimit} min={0} max={100} unit="%" helper="Simulated curtailment" />
          <button className="review-button" onClick={() => setReview(true)}><Check size={16} /> Review changes</button>
        </Card>
        <Card>
          <div className="card-heading"><div><span className="eyebrow">ACTIVITY LOG</span><h3>Recent backend events</h3></div></div>
          <div className="activity-log">{activity.slice(0, 5).map((entry) => <div key={entry.activityId}><span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><p>{entry.message}</p></div>)}</div>
        </Card>
      </div>
    </div>
    {review && <div className="modal-backdrop"><div className="confirm-modal"><button className="close-modal" onClick={() => setReview(false)}><X size={18} /></button><span className="eyebrow">CONFIRM SIMULATION</span><h2>Apply these simulated changes?</h2><p>No physical command will be sent.</p><div className="review-list"><MetricRow label="Battery reserve" value={`${reserve}%`} /><MetricRow label="Grid export limit" value={`${exportLimit} MW`} /><MetricRow label="Battery mode" value={mode} /><MetricRow label="Operating mode" value={operatingMode} /><MetricRow label="Farm output" value={`${outputLimit}%`} /></div><div className="modal-actions"><button className="secondary-button" onClick={() => setReview(false)}>Back</button><button className="primary-button" onClick={applyOperations}>Apply simulation</button></div></div></div>}
  </div>
}

function AlertItem({ alert, onToggle }) { const Icon = alert.severity === 'info' ? Bot : AlertTriangle; return <div className={`alert-item ${alert.severity} ${alert.acknowledged ? 'acknowledged' : ''}`}><div className="alert-icon"><Icon size={18} /></div><div className="alert-copy"><div><strong>{alert.title}</strong><span>{relativeTime(alert.generatedAt)}</span></div><p>{alert.description}</p><small>{alert.farm} · {alert.tab}</small></div><button className="ack-button" onClick={onToggle}>{alert.acknowledged ? <><Check size={14} /> Acknowledged</> : 'Acknowledge'}</button></div> }
function Alerts({ alertItems, setAlertItems }) {
  const [tab, setTab] = useState('All')
  const [error, setError] = useState('')
  const tabs = ['All', 'Critical', 'Operational', 'Forecast', 'Weather', 'Grid', 'AI']
  const filtered = alertItems.filter((alert) => tab === 'All' || (tab === 'Critical' ? alert.severity === 'critical' : alert.tab === tab))
  const toggleAlert = async (alert) => {
    try {
      const updated = await energyService.updateAlert(alert.id, !alert.acknowledged)
      setAlertItems(alertItems.map((item) => item.id === alert.id ? updated : item))
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    }
  }
  return <div className="page-stack">
    <SectionHeader eyebrow="OPERATIONS CENTER" title="Alerts & signals" action={<span className="active-alert-count"><span className="status-dot critical" /> {alertItems.filter((alert) => !alert.acknowledged).length} active</span>} />
    {error && <div className="model-error"><AlertTriangle size={15} /> {error}</div>}
    <div className="alert-tabs">{tabs.map((item) => <button className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item}</button>)}</div>
    <div className="alerts-list">{filtered.map((alert) => <AlertItem alert={alert} key={alert.id} onToggle={() => toggleAlert(alert)} />)}</div>
  </div>
}

function App() { const { alerts, farms } = useDashboardData(); const [theme, setTheme] = useState(() => localStorage.getItem('gridline-theme') || 'dark'); const [selectedFarm, setSelectedFarm] = useState('sunpeak'); const [alertItems, setAlertItems] = useState(alerts); const navigate = useNavigate(); useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('gridline-theme', theme) }, [theme]); const goToFarm = (id) => { setSelectedFarm(id); navigate('/farm') }; return <AppShell selectedFarm={selectedFarm} setSelectedFarm={setSelectedFarm} theme={theme} setTheme={setTheme}><Routes><Route path="/" element={<FleetOverview onFarmSelect={goToFarm} />} /><Route path="/farm-explorer" element={<Suspense fallback={<div className="app-loading"><Compass size={20} /> Preparing your energy world…</div>}><FarmExplorerPage farms={farms} alerts={alertItems} onFarmSelect={goToFarm} /></Suspense>} /><Route path="/farm" element={<FarmDetail selectedFarm={selectedFarm} setSelectedFarm={setSelectedFarm} />} /><Route path="/forecast" element={<ForecastAI selectedFarm={selectedFarm} />} /><Route path="/performance" element={<Performance />} /><Route path="/operations" element={<Operations selectedFarm={selectedFarm} setSelectedFarm={setSelectedFarm} />} /><Route path="/alerts" element={<Alerts alertItems={alertItems} setAlertItems={setAlertItems} />} /></Routes></AppShell> }
export default function Root() { return <BrowserRouter><DashboardDataProvider><App /></DashboardDataProvider></BrowserRouter> }

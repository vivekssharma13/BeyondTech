import { Component, useEffect, useMemo, useState } from 'react'
import { Compass, RotateCcw, Sun, Wind, ZoomIn, ZoomOut } from 'lucide-react'
import FarmWorld from './FarmWorld'
import './FarmExplorer.css'

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(window.WebGLRenderingContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')))
  } catch {
    return false
  }
}

function ExplorerLoading() {
  return <div className="explorer-loading"><span className="explorer-loader"><Sun size={23} /></span><strong>Preparing your energy world…</strong><small>Building the miniature farms</small></div>
}

class SceneErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div className="explorer-empty explorer-canvas-error"><Compass size={30} /><h2>The 3D world could not start</h2><p>WebGL initialization failed. You can continue using the other dashboard pages.</p></div>
    return this.props.children
  }
}

function HoverCard({ hover }) {
  if (!hover) return null
  const { farm, alertCount, x, y } = hover
  return <aside className="explorer-hover-card" style={{ left: x, top: y }}>
    <div className="explorer-card-title"><span className={`explorer-type-icon ${farm.type}`}>{farm.type === 'solar' ? <Sun size={16} /> : <Wind size={16} />}</span><div><strong>{farm.name || 'Unnamed farm'}</strong><span>{farm.type === 'solar' ? 'Solar energy' : farm.type === 'wind' ? 'Wind energy' : 'Energy asset'}</span></div></div>
    <dl><div><dt>Status</dt><dd className={`explorer-health ${farm.status || 'unknown'}`}>{farm.status || 'Not available'}</dd></div><div><dt>Generation</dt><dd>{Number.isFinite(farm.currentGenerationMW) ? `${farm.currentGenerationMW} MW` : '—'}</dd></div><div><dt>Capacity</dt><dd>{Number.isFinite(farm.capacityMW) ? `${farm.capacityMW} MW` : '—'}</dd></div><div><dt>Active alerts</dt><dd>{alertCount ?? '—'}</dd></div></dl>
    <p>SIMULATED TELEMETRY</p><small>Click to view farm details →</small>
  </aside>
}

export default function FarmExplorerPage({ farms = [], alerts = [], onFarmSelect }) {
  const [ready, setReady] = useState(false)
  const [hover, setHover] = useState(null)
  const [cameraCommand, setCameraCommand] = useState({ type: 'reset', id: 0 })
  const [webglAvailable] = useState(() => supportsWebGL())
  const counts = useMemo(() => ({ solar: farms.filter((farm) => farm.type === 'solar').length, wind: farms.filter((farm) => farm.type === 'wind').length }), [farms])

  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), 180)
    return () => window.clearTimeout(id)
  }, [])

  const command = (type) => setCameraCommand((current) => ({ type, id: current.id + 1 }))
  const moveHover = (farm, event) => {
    const cardWidth = 270
    const x = Math.min(window.innerWidth - cardWidth - 18, Math.max(18, event.clientX + 18))
    const y = Math.min(window.innerHeight - 270, Math.max(78, event.clientY - 60))
    const alertCount = alerts.filter((alert) => alert.farm === farm.name && !alert.acknowledged).length
    setHover({ farm, alertCount, x, y })
  }

  if (!webglAvailable) return <div className="explorer-empty"><Compass size={34} /><h2>3D rendering is unavailable</h2><p>This browser or device does not currently provide WebGL. The rest of the dashboard is still available.</p></div>
  if (!farms.length) return <div className="explorer-empty"><Compass size={34} /><h2>No farms to explore</h2><p>Add farms through the existing data source and they will appear here automatically.</p></div>

  return <div className="farm-explorer-page">
    {!ready && <ExplorerLoading />}
    <div className="explorer-heading"><div><span>INTERACTIVE NETWORK</span><h1>Energy Farm Explorer</h1><p>Explore your renewable energy network</p></div><div className="explorer-counts"><span><Sun size={15} /> {counts.solar} solar</span><span><Wind size={15} /> {counts.wind} wind</span></div></div>
    <div className={`explorer-stage ${ready ? 'is-ready' : ''}`}>
      <SceneErrorBoundary><FarmWorld farms={farms} cameraCommand={cameraCommand} onHover={moveHover} onLeave={() => setHover(null)} onSelect={onFarmSelect} /></SceneErrorBoundary>
      <div className="explorer-controls" aria-label="3D camera controls"><button onClick={() => command('reset')}><RotateCcw size={16} /><span>Reset view</span></button><button onClick={() => command('zoomIn')} aria-label="Zoom in"><ZoomIn size={17} /></button><button onClick={() => command('zoomOut')} aria-label="Zoom out"><ZoomOut size={17} /></button></div>
      <div className="explorer-help"><span className="explorer-key">W</span><span className="explorer-key">A</span><span className="explorer-key">S</span><span className="explorer-key">D</span><p>Drag to rotate · Scroll to zoom · WASD to move · Click a farm to explore</p></div>
      <div className="explorer-source">SIMULATED FARM STATE</div>
      <HoverCard hover={hover} />
    </div>
  </div>
}

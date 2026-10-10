import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Float, OrbitControls, RoundedBox } from '@react-three/drei'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'

const DEFAULT_CAMERA = new THREE.Vector3(15, 14, 19)
const DEFAULT_TARGET = new THREE.Vector3(0, 0, 0)

function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}

function CameraControls({ command }) {
  const controls = useRef()
  const keys = useRef(new Set())
  const interacting = useRef(false)
  const { camera } = useThree()
  const desiredPosition = useRef(DEFAULT_CAMERA.clone())
  const desiredTarget = useRef(DEFAULT_TARGET.clone())

  useEffect(() => {
    const pressedKeys = keys.current
    const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    const down = (event) => { if (!isTyping() && ['w', 'a', 's', 'd'].includes(event.key.toLowerCase())) pressedKeys.add(event.key.toLowerCase()) }
    const up = (event) => pressedKeys.delete(event.key.toLowerCase())
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); pressedKeys.clear() }
  }, [])

  useEffect(() => {
    if (!command?.id) return
    if (command.type === 'reset') {
      desiredPosition.current.copy(DEFAULT_CAMERA)
      desiredTarget.current.copy(DEFAULT_TARGET)
    } else {
      const direction = camera.position.clone().sub(controls.current.target).normalize()
      const amount = command.type === 'zoomIn' ? -2.5 : 2.5
      desiredPosition.current.copy(camera.position).addScaledVector(direction, amount)
      desiredTarget.current.copy(controls.current.target)
    }
  }, [command, camera])

  useFrame((_, delta) => {
    const control = controls.current
    if (!control) return
    if (keys.current.size) {
      const forward = new THREE.Vector3().subVectors(control.target, camera.position).setY(0).normalize()
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
      const movement = new THREE.Vector3()
      if (keys.current.has('w')) movement.add(forward)
      if (keys.current.has('s')) movement.sub(forward)
      if (keys.current.has('d')) movement.add(right)
      if (keys.current.has('a')) movement.sub(right)
      if (movement.lengthSq()) {
        movement.normalize().multiplyScalar(delta * 5)
        const nextTarget = control.target.clone().add(movement)
        if (nextTarget.length() < 11) {
          camera.position.add(movement)
          control.target.add(movement)
          desiredPosition.current.copy(camera.position)
          desiredTarget.current.copy(control.target)
        }
      }
    }
    if (!interacting.current) {
      camera.position.lerp(desiredPosition.current, 1 - Math.exp(-delta * 4.5))
      control.target.lerp(desiredTarget.current, 1 - Math.exp(-delta * 4.5))
    }
    control.update()
  })

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.07} minDistance={9} maxDistance={34} minPolarAngle={0.35} maxPolarAngle={1.35} enablePan={false} onStart={() => { interacting.current = true }} onEnd={() => { interacting.current = false; if (controls.current) { desiredPosition.current.copy(camera.position); desiredTarget.current.copy(controls.current.target) } }} />
}

function SolarPanel({ position, phase }) {
  const material = useRef()
  useFrame(({ clock }) => {
    if (material.current) material.current.emissiveIntensity = 0.05 + Math.max(0, Math.sin(clock.elapsedTime * 0.7 + phase) - 0.92) * 1.8
  })
  return <group position={position} rotation={[-0.32, 0, 0]}><mesh castShadow><boxGeometry args={[1.25, 0.08, 0.72]} /><meshStandardMaterial ref={material} color="#173B70" emissive="#53D8FB" emissiveIntensity={0.05} metalness={0.7} roughness={0.24} /></mesh><mesh position={[0, -0.23, 0.16]} castShadow><boxGeometry args={[0.08, 0.48, 0.08]} /><meshStandardMaterial color="#C5D6E2" metalness={0.65} roughness={0.35} /></mesh></group>
}

function SolarFarm() {
  const panels = [[-0.75, 0.62, -0.5], [0.75, 0.62, -0.5], [-0.75, 0.62, 0.42], [0.75, 0.62, 0.42]]
  return <group>{panels.map((position, index) => <SolarPanel key={index} position={position} phase={index * 0.8} />)}<mesh position={[0, 0.16, 0]} receiveShadow><cylinderGeometry args={[2.1, 2.2, 0.3, 32]} /><meshStandardMaterial color="#B6E4B8" roughness={0.9} /></mesh></group>
}

function WindTurbine({ position, phase }) {
  const blades = useRef()
  useFrame((_, delta) => { if (blades.current) blades.current.rotation.z -= delta * (0.72 + phase * 0.05) })
  return <group position={position}><mesh position={[0, 1.55, 0]} castShadow><cylinderGeometry args={[0.11, 0.22, 3.1, 12]} /><meshStandardMaterial color="#F5F8FC" roughness={0.42} /></mesh><mesh position={[0, 3.13, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow><capsuleGeometry args={[0.18, 0.5, 5, 10]} /><meshStandardMaterial color="#36B8AC" roughness={0.36} /></mesh><group ref={blades} position={[0, 3.14, 0.3]}>{[0, 1, 2].map((blade) => <group key={blade} rotation={[0, 0, blade * Math.PI * 2 / 3]}><mesh position={[0, 1.02, 0]} castShadow><boxGeometry args={[0.12, 2.05, 0.07]} /><meshStandardMaterial color="#F5F8FC" roughness={0.45} /></mesh></group>) }<mesh position={[0, 0, 0.03]}><sphereGeometry args={[0.24, 14, 10]} /><meshStandardMaterial color="#36B8AC" /></mesh></group></group>
}

function WindFarm() {
  return <group><WindTurbine position={[-0.7, 0.25, 0]} phase={0} /><WindTurbine position={[0.85, 0.25, 0.42]} phase={1} /><mesh position={[0, 0.16, 0]} receiveShadow><cylinderGeometry args={[2.1, 2.2, 0.3, 32]} /><meshStandardMaterial color="#B6E4B8" roughness={0.9} /></mesh></group>
}

function FarmPlot({ farm, position, rotation, onHover, onLeave, onSelect }) {
  const group = useRef()
  const [hovered, setHovered] = useState(false)
  const [selected, setSelected] = useState(false)
  const clickTimer = useRef()
  useEffect(() => () => { window.clearTimeout(clickTimer.current); document.body.style.cursor = '' }, [])
  useFrame((_, delta) => {
    if (!group.current) return
    const targetScale = selected ? 1.14 : hovered ? 1.07 : 1
    const scale = THREE.MathUtils.damp(group.current.scale.x, targetScale, 8, delta)
    group.current.scale.setScalar(scale)
    group.current.position.y = THREE.MathUtils.damp(group.current.position.y, hovered ? 0.4 : 0.22, 8, delta)
  })
  const enter = (event) => { event.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; onHover(farm, event) }
  const leave = (event) => { event.stopPropagation(); setHovered(false); document.body.style.cursor = ''; onLeave() }
  const select = (event) => { event.stopPropagation(); if (!farm.id) return; setSelected(true); clickTimer.current = window.setTimeout(() => onSelect(farm.id), 180) }
  return <group ref={group} position={position} rotation={[0, rotation, 0]} onPointerOver={enter} onPointerMove={enter} onPointerOut={leave} onClick={select}>
    <pointLight color="#36D6E7" intensity={hovered || selected ? 7 : 0} distance={5} position={[0, 2, 0]} />
    {farm.type === 'solar' ? <SolarFarm /> : farm.type === 'wind' ? <WindFarm /> : <RoundedBox args={[2.5, 1.2, 2.5]} position={[0, 0.7, 0]}><meshStandardMaterial color="#91A3B0" /></RoundedBox>}
  </group>
}

function layoutFarms(farms) {
  if (farms.length <= 8) {
    const radius = Math.max(5.3, farms.length * 1.18)
    return farms.map((farm, index) => ({ farm, radius, angle: index / farms.length * Math.PI * 2 - Math.PI / 2 }))
  }
  return farms.map((farm, index) => {
    const innerCount = Math.ceil(farms.length / 2)
    const inner = index < innerCount
    const ringIndex = inner ? index : index - innerCount
    const ringCount = inner ? innerCount : farms.length - innerCount
    return { farm, radius: inner ? 5.2 : 9, angle: ringIndex / ringCount * Math.PI * 2 - Math.PI / 2 + (inner ? 0 : 0.32) }
  })
}

function Tree({ position, scale = 1 }) {
  return <group position={position} scale={scale}><mesh position={[0, 0.42, 0]} castShadow><cylinderGeometry args={[0.1, 0.14, 0.85, 8]} /><meshStandardMaterial color="#8B6645" /></mesh><mesh position={[0, 1.15, 0]} castShadow><dodecahedronGeometry args={[0.64, 0]} /><meshStandardMaterial color="#4AA879" roughness={0.9} /></mesh></group>
}

function WindStreak({ position, delay }) {
  const ref = useRef()
  useFrame(({ clock }) => { if (ref.current) ref.current.position.x = position[0] + ((clock.elapsedTime * 0.55 + delay) % 3.5) - 1.75 })
  return <mesh ref={ref} position={position} rotation={[0, 0, -0.08]}><capsuleGeometry args={[0.018, 0.9, 3, 8]} /><meshBasicMaterial color="#EAF8FF" transparent opacity={0.6} /></mesh>
}

function Island({ radius }) {
  const trees = [[-3.2, -1.2, .8], [3.1, -1.4, .72], [-1.3, 3.1, .65], [2.2, 2.8, .62], [-4.1, 2.1, .55]]
  return <group><mesh position={[0, -0.58, 0]} receiveShadow><cylinderGeometry args={[radius - 0.2, radius, 1.25, 64]} /><meshStandardMaterial color="#6E9F72" roughness={0.94} /></mesh><mesh position={[0, 0.02, 0]} receiveShadow><cylinderGeometry args={[radius, radius - 0.2, 0.22, 64]} /><meshStandardMaterial color="#83C995" roughness={0.95} /></mesh><mesh position={[0, 0.16, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[2.2, 2.55, 64]} /><meshStandardMaterial color="#E7D7A5" roughness={1} /></mesh>{trees.filter(([x, z]) => Math.hypot(x, z) < radius - 1).map(([x, z, scale], index) => <Tree key={index} position={[x, 0.13, z]} scale={scale} />)}<Float speed={1.2} rotationIntensity={0.15} floatIntensity={0.25}><group position={[0, 1.2, 0]}><mesh castShadow><torusGeometry args={[0.72, 0.14, 12, 32]} /><meshStandardMaterial color="#36B8AC" metalness={0.45} roughness={0.28} /></mesh><mesh rotation={[0, 0, Math.PI / 2]} castShadow><capsuleGeometry args={[0.16, 1.2, 6, 12]} /><meshStandardMaterial color="#FFD166" emissive="#FFD166" emissiveIntensity={0.15} /></mesh></group></Float></group>
}

function World({ farms, cameraCommand, onHover, onLeave, onSelect }) {
  const layout = useMemo(() => layoutFarms(farms), [farms])
  const radius = farms.length > 8 ? 12 : Math.max(8.2, farms.length * 1.5)
  return <><color attach="background" args={["#BFE8FF"]} /><fog attach="fog" args={["#EAF8FF", 27, 55]} /><ambientLight intensity={1.25} color="#EAF8FF" /><hemisphereLight intensity={1.2} color="#FFF0BB" groundColor="#6E9F72" /><directionalLight position={[9, 15, 8]} intensity={2.3} color="#FFF0BB" castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-16} shadow-camera-right={16} shadow-camera-top={16} shadow-camera-bottom={-16} /><Island radius={radius} />{layout.map(({ farm, radius: farmRadius, angle }) => <FarmPlot key={farm.id} farm={farm} position={[Math.cos(angle) * farmRadius, 0.22, Math.sin(angle) * farmRadius]} rotation={-angle + Math.PI / 2} onHover={onHover} onLeave={onLeave} onSelect={onSelect} />)}<mesh position={[8.7, 9.3, -8]}><sphereGeometry args={[1.15, 24, 18]} /><meshBasicMaterial color="#FFD166" /></mesh><pointLight position={[8.7, 9.3, -8]} color="#FFD166" intensity={18} distance={25} /><WindStreak position={[-5, 5.2, -5]} delay={0} /><WindStreak position={[1, 7, -7]} delay={1.4} /><WindStreak position={[5, 4.2, -3]} delay={2.1} /><ContactShadows position={[0, 0.04, 0]} opacity={0.34} scale={radius * 2} blur={2.8} far={15} resolution={512} /><CameraControls command={cameraCommand} /></>
}

export default function FarmWorld(props) {
  const visible = usePageVisible()
  return <Canvas className="farm-world-canvas" shadows dpr={[1, 1.6]} camera={{ position: DEFAULT_CAMERA.toArray(), fov: 43, near: 0.1, far: 100 }} frameloop={visible ? 'always' : 'demand'} gl={{ antialias: true, powerPreference: 'high-performance' }} onPointerMissed={props.onLeave}>
    <Suspense fallback={null}><World {...props} /></Suspense>
  </Canvas>
}

import * as CANNON from 'cannon-es'
import * as THREE from 'three'
import seedrandom from 'seedrandom'
import { clamp } from 'three/src/math/MathUtils'
import type { FolderApi } from 'tweakpane'
import { Pane } from 'tweakpane'
import * as BufferGeometryUtils from './BufferGeometryUtils'

const canvasEl = document.querySelector('#canvas')!
const simulationResult = document.querySelector('#simulation-result')!
let renderId: symbol

let renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  diceMesh: THREE.Group,
  simulationWorld: CANNON.World

const pane = new Pane()

const params = {
  numberOfDice: 2,
  desiredRolls: [6, 3],
  magic: false,
  seed: '',
  storeFrames: false,
}

// Fixed constants (not configurable)
const SEGMENTS = 40
const EDGE_RADIUS = 0.07
const NOTCH_RADIUS = 0.12
const NOTCH_DEPTH = 0.1
const BOX_WIDTH = 10
const BOX_HEIGHT = 6

const meshArray: THREE.Group[] = []
const simulationDiceArray: CANNON.Body[] = []
const wallBodies: CANNON.Body[] = []

// Parse query parameters on page load
parseQueryParams()

initPhysics()
initScene()
initUI()

throwDice(params.seed || undefined)

window.addEventListener('resize', updateSceneSize)

function parseQueryParams() {
  const urlParams = new URLSearchParams(window.location.search)

  if (urlParams.has('numberOfDice')) {
    const value = Number.parseInt(urlParams.get('numberOfDice')!)
    if (!Number.isNaN(value) && value >= 1 && value <= 10)
      params.numberOfDice = value
  }

  if (urlParams.has('magic'))
    params.magic = urlParams.get('magic') === 'true'

  if (urlParams.has('seed'))
    params.seed = urlParams.get('seed') || ''

  if (urlParams.has('storeFrames'))
    params.storeFrames = urlParams.get('storeFrames') === 'true'

  if (urlParams.has('desiredRolls')) {
    try {
      const rolls = JSON.parse(urlParams.get('desiredRolls')!)
      if (Array.isArray(rolls) && rolls.every(r => Number.isInteger(r) && r >= 1 && r <= 6))
        params.desiredRolls = rolls
    }
    catch {
      // Invalid JSON, use defaults
    }
  }
}

function updateURL() {
  const url = new URL(window.location.href)
  url.searchParams.set('numberOfDice', params.numberOfDice.toString())
  url.searchParams.set('magic', params.magic.toString())
  url.searchParams.set('seed', params.seed)
  url.searchParams.set('desiredRolls', JSON.stringify(params.desiredRolls))
  window.history.replaceState({}, '', url.toString())
}

function initUI() {
  let magicFolder: FolderApi
  const folder = pane.addFolder({ title: 'Params' })
  folder.addBinding(params, 'numberOfDice', {
    label: 'Number of Dice',
    min: 1,
    max: 10,
    step: 1,
  }).on('change', () => {
    initDice()
    magicFolder.children.forEach(child => magicFolder.remove(child))
    params.desiredRolls = simulationDiceArray.map((_, i) => params.desiredRolls[i] ?? 1)
    params.desiredRolls.forEach((_, i) =>
      // @ts-expect-error: tweakpane type bug
      magicFolder.addBinding(params.desiredRolls, `${i}`, {
        min: 1,
        max: 6,
        step: 1,
      }))
  })

  folder.addBinding(params, 'seed')

  folder.addBinding(params, 'magic')
    .on('change', () => {
      magicFolder.hidden = !params.magic
    })

  magicFolder = folder.addFolder({ title: 'Magic!' })
  params.desiredRolls = simulationDiceArray.map(() => 1) // result is 1 by default
  params.desiredRolls.forEach((_, i) =>
    // @ts-expect-error: tweakpane type bug
    magicFolder.addBinding(params.desiredRolls, `${i}`, {
      min: 1,
      max: 6,
      step: 1,
    }))
  magicFolder.hidden = !params.magic

  folder.addButton({ title: 'Throw Dice' })
    .on('click', () => throwDice(params.seed || undefined))

  pane.on('change', () => {
    localStorage.setItem('PANE_STATE', JSON.stringify(pane.exportState()))
    updateURL()
  })

  if (localStorage.getItem('PANE_STATE'))
    pane.importState(JSON.parse(localStorage.getItem('PANE_STATE')!))
}

function initScene() {
  renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    canvas: canvasEl,
  })
  renderer.shadowMap.enabled = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  scene = new THREE.Scene()

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300)
  camera.position.set(0, 2, 0).multiplyScalar(7)
  camera.lookAt(0, -7, 0)
  camera.zoom = 1.5

  updateSceneSize()

  const ambientLight = new THREE.AmbientLight(0xFFFFFF, 0.5)
  scene.add(ambientLight)
  const topLight = new THREE.PointLight(0xFFFFFF, 0.5)
  topLight.position.set(10, 15, 0)
  topLight.castShadow = true
  topLight.shadow.mapSize.width = 2048
  topLight.shadow.mapSize.height = 2048
  topLight.shadow.camera.near = 5
  topLight.shadow.camera.far = 400
  scene.add(topLight)

  createFloor()
  createInvisibleWalls()
  diceMesh = createDiceMesh()
  initDice()
}

function initDice() {
  simulationDiceArray.forEach(dice => simulationWorld.removeBody(dice))
  simulationDiceArray.length = 0
  meshArray.forEach(mesh => scene.remove(mesh))
  meshArray.length = 0
  for (let i = 0; i < params.numberOfDice; i++)
    createDice()
}

function initPhysics() {
  simulationWorld = new CANNON.World({
    allowSleep: true,
    gravity: new CANNON.Vec3(0, -50, 0),
  })
  simulationWorld.defaultContactMaterial.restitution = 0.3
}

function createFloor() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.ShadowMaterial({
      opacity: 0.1,
    }),
  )
  floor.receiveShadow = false
  floor.position.y = -7
  floor.quaternion.setFromAxisAngle(new THREE.Vector3(-1, 0, 0), Math.PI * 0.5)
  scene.add(floor)

  const simulationFloorBody = new CANNON.Body({
    type: CANNON.Body.STATIC,
    shape: new CANNON.Plane(),
  })
  simulationFloorBody.position.copy(floor.position as unknown as CANNON.Vec3)
  simulationFloorBody.quaternion.copy(floor.quaternion as unknown as CANNON.Quaternion)
  simulationWorld.addBody(simulationFloorBody)
}

function createInvisibleWalls() {
  const halfWidth = BOX_WIDTH / 2
  const halfHeight = BOX_HEIGHT / 2
  const wallHeight = 10 // Height of the invisible walls
  const floorY = -7 // Same as floor position

  // Create invisible wall bodies for physics simulation
  const walls = [
    // Front wall (positive Z)
    {
      position: new CANNON.Vec3(0, floorY + wallHeight / 2, halfHeight),
      shape: new CANNON.Box(new CANNON.Vec3(halfWidth, wallHeight / 2, 0.1)),
    },
    // Back wall (negative Z)
    {
      position: new CANNON.Vec3(0, floorY + wallHeight / 2, -halfHeight),
      shape: new CANNON.Box(new CANNON.Vec3(halfWidth, wallHeight / 2, 0.1)),
    },
    // Left wall (negative X)
    {
      position: new CANNON.Vec3(-halfWidth, floorY + wallHeight / 2, 0),
      shape: new CANNON.Box(new CANNON.Vec3(0.1, wallHeight / 2, halfHeight)),
    },
    // Right wall (positive X)
    {
      position: new CANNON.Vec3(halfWidth, floorY + wallHeight / 2, 0),
      shape: new CANNON.Box(new CANNON.Vec3(0.1, wallHeight / 2, halfHeight)),
    },
  ]

  walls.forEach((wall) => {
    const wallBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: wall.shape,
    })
    wallBody.position.copy(wall.position)
    simulationWorld.addBody(wallBody)
    wallBodies.push(wallBody)
  })
}

function createDiceMesh() {
  const boxMaterialOuter = new THREE.MeshStandardMaterial({
    color: 0xEEEEEE,
  })
  const boxMaterialInner = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0,
    metalness: 1,
    side: THREE.DoubleSide,
  })

  const diceMesh = new THREE.Group()
  const innerMesh = new THREE.Mesh(createInnerGeometry(), boxMaterialInner)
  const outerMesh = new THREE.Mesh(createBoxGeometry(), boxMaterialOuter)
  outerMesh.castShadow = true
  diceMesh.add(innerMesh, outerMesh)

  return diceMesh
}

function createDice() {
  const mesh = diceMesh.clone()
  scene.add(mesh)
  meshArray.push(mesh)

  const simulationBody = new CANNON.Body({
    mass: 1,
    shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
    sleepTimeLimit: 0.1,
  })
  simulationDiceArray.push(simulationBody)
  simulationWorld.addBody(simulationBody)

  return mesh
}

function createBoxGeometry() {
  let boxGeometry = new THREE.BoxGeometry(1, 1, 1, SEGMENTS, SEGMENTS, SEGMENTS)

  const positionAttr = boxGeometry.attributes.position
  const subCubeHalfSize = 0.5 - EDGE_RADIUS

  for (let i = 0; i < positionAttr.count; i++) {
    let position = new THREE.Vector3().fromBufferAttribute(positionAttr, i)

    const subCube = new THREE.Vector3(Math.sign(position.x), Math.sign(position.y), Math.sign(position.z)).multiplyScalar(subCubeHalfSize)
    const addition = new THREE.Vector3().subVectors(position, subCube)

    if (Math.abs(position.x) > subCubeHalfSize && Math.abs(position.y) > subCubeHalfSize && Math.abs(position.z) > subCubeHalfSize) {
      addition.normalize().multiplyScalar(EDGE_RADIUS)
      position = subCube.add(addition)
    }
    else if (Math.abs(position.x) > subCubeHalfSize && Math.abs(position.y) > subCubeHalfSize) {
      addition.z = 0
      addition.normalize().multiplyScalar(EDGE_RADIUS)
      position.x = subCube.x + addition.x
      position.y = subCube.y + addition.y
    }
    else if (Math.abs(position.x) > subCubeHalfSize && Math.abs(position.z) > subCubeHalfSize) {
      addition.y = 0
      addition.normalize().multiplyScalar(EDGE_RADIUS)
      position.x = subCube.x + addition.x
      position.z = subCube.z + addition.z
    }
    else if (Math.abs(position.y) > subCubeHalfSize && Math.abs(position.z) > subCubeHalfSize) {
      addition.x = 0
      addition.normalize().multiplyScalar(EDGE_RADIUS)
      position.y = subCube.y + addition.y
      position.z = subCube.z + addition.z
    }

    const notchWave = (v: number) => {
      v = (1 / NOTCH_RADIUS) * v
      v = Math.PI * Math.max(-1, Math.min(1, v))
      return NOTCH_DEPTH * (Math.cos(v) + 1.0)
    }
    const notch = (pos: [number, number]) => notchWave(pos[0]) * notchWave(pos[1])

    const offset = 0.23

    if (position.y === 0.5) {
      position.y -= notch([position.x, position.z])
    }
    else if (position.x === 0.5) {
      position.x -= notch([position.y + offset, position.z + offset])
      position.x -= notch([position.y - offset, position.z - offset])
    }
    else if (position.z === 0.5) {
      position.z -= notch([position.x - offset, position.y + offset])
      position.z -= notch([position.x, position.y])
      position.z -= notch([position.x + offset, position.y - offset])
    }
    else if (position.z === -0.5) {
      position.z += notch([position.x + offset, position.y + offset])
      position.z += notch([position.x + offset, position.y - offset])
      position.z += notch([position.x - offset, position.y + offset])
      position.z += notch([position.x - offset, position.y - offset])
    }
    else if (position.x === -0.5) {
      position.x += notch([position.y + offset, position.z + offset])
      position.x += notch([position.y + offset, position.z - offset])
      position.x += notch([position.y, position.z])
      position.x += notch([position.y - offset, position.z + offset])
      position.x += notch([position.y - offset, position.z - offset])
    }
    else if (position.y === -0.5) {
      position.y += notch([position.x + offset, position.z + offset])
      position.y += notch([position.x + offset, position.z])
      position.y += notch([position.x + offset, position.z - offset])
      position.y += notch([position.x - offset, position.z + offset])
      position.y += notch([position.x - offset, position.z])
      position.y += notch([position.x - offset, position.z - offset])
    }

    positionAttr.setXYZ(i, position.x, position.y, position.z)
  }

  boxGeometry.deleteAttribute('normal')
  boxGeometry.deleteAttribute('uv')
  boxGeometry = BufferGeometryUtils.mergeVertices(boxGeometry)

  boxGeometry.computeVertexNormals()

  return boxGeometry
}

function createInnerGeometry() {
  const baseGeometry = new THREE.PlaneGeometry(1 - 2 * EDGE_RADIUS, 1 - 2 * EDGE_RADIUS)
  const offset = 0.48
  // return BufferGeometryUtils.mergeGeometries([
  return BufferGeometryUtils.mergeBufferGeometries([
    baseGeometry.clone().translate(0, 0, offset),
    baseGeometry.clone().translate(0, 0, -offset),
    baseGeometry.clone().rotateX(0.5 * Math.PI).translate(0, -offset, 0),
    baseGeometry.clone().rotateX(0.5 * Math.PI).translate(0, offset, 0),
    baseGeometry.clone().rotateY(0.5 * Math.PI).translate(-offset, 0, 0),
    baseGeometry.clone().rotateY(0.5 * Math.PI).translate(offset, 0, 0),
  ], false)!
}

function showSimulationResults(score: number) {
  if (simulationResult.textContent === '')
    simulationResult.textContent += score
  else
    simulationResult.textContent += (`+${score}`)
}

function updateSceneSize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.render(scene, camera)
}

(window as any).throwDice = throwDice
function throwDice(seed?: string) {
  // eslint-disable-next-line symbol-description
  renderId = Symbol()
  renderSimulation(simulateThrow(seed), renderId)
}

function generateNonOverlappingPositions(numDice: number, rng: () => number): CANNON.Vec3[] {
  const positions: CANNON.Vec3[] = []
  const minDistance = 1.8 // Reduced minimum distance for closer spacing
  const maxAttempts = 100 // Maximum attempts to find a valid position
  const startHeight = 3 // Height above the floor to start dice
  const fixedZ = 0 // All dice start in the same Z plane (centered)

  // Calculate usable area within the invisible walls - more conservative margins
  const usableWidth = Math.min(BOX_WIDTH - 2, 8) // Limit to reasonable area, leave 1 unit margin on each side
  const halfUsableWidth = usableWidth / 2

  for (let i = 0; i < numDice; i++) {
    let validPosition = false
    let attempts = 0
    let newPosition: CANNON.Vec3

    do {
      // Generate random X position within the constrained area, same Z for all
      const x = (rng() - 0.5) * 2 * halfUsableWidth
      const y = startHeight + rng() * 1 // Small random height variation

      newPosition = new CANNON.Vec3(x, y, fixedZ)

      // Check if this position is far enough from all existing positions (only check X distance since Z is fixed)
      validPosition = positions.every((existingPos) => {
        const distance = Math.abs(newPosition.x - existingPos.x)
        return distance >= minDistance
      })

      attempts++
    } while (!validPosition && attempts < maxAttempts)

    // If we couldn't find a valid position after max attempts, fall back to a grid position
    if (!validPosition) {
      const fallbackX = (i - (numDice - 1) / 2) * minDistance // Center the grid around 0
      newPosition = new CANNON.Vec3(fallbackX, startHeight, fixedZ)
    }

    positions.push(newPosition)
  }

  return positions
}

function simulateThrow(seed?: string, retryCount = 0) {
  simulationResult.textContent = ''
  seed ??= Math.random().toString(36).slice(2)
  const rng = seedrandom(seed)
  let numSlept = 0
  const simulationRecord: [CANNON.Vec3, CANNON.Quaternion][][] = []
  const rollResult = simulationDiceArray.map(() => 1)

  const eventHandlers: (Function | null)[] = []

  // Generate random positions for dice that don't overlap
  const dicePositions = generateNonOverlappingPositions(params.numberOfDice, rng)

  // Stuck detection variables
  const stuckDetectionThreshold = 0.001 // Negligible movement threshold
  const stuckDetectionSteps = 1000 // Number of steps to check for stuck state
  let lastPositions: CANNON.Vec3[] = []

  simulationDiceArray.forEach((body, dIdx) => {
    body.velocity.setZero()
    body.angularVelocity.setZero()

    body.position = dicePositions[dIdx]

    const rotation = new THREE.Euler(2 * Math.PI * rng(), 2 * Math.PI * rng(), 2 * Math.PI * rng())
    body.quaternion.copy(new THREE.Quaternion().setFromEuler(rotation) as unknown as CANNON.Quaternion)

    const force = 3 + 10 * rng()
    const theta = 2 * Math.PI * rng()
    body.applyImpulse(
      new CANNON.Vec3(Math.sin(theta) * force, Math.cos(theta) * force, 0),
      new CANNON.Vec3(0, 0, 0.2),
    )

    body.allowSleep = true

    const eventHandler = (e: any) => {
      body.allowSleep = false

      const euler = new CANNON.Vec3()
      e.target.quaternion.toEuler(euler)

      const face = getFaceUp(euler)
      if (face) {
        numSlept += 1
        showSimulationResults(face)
        rollResult[dIdx] = face
        eventHandlers[dIdx] = null
        body.removeEventListener('sleep', eventHandler)
      }
      else {
        body.allowSleep = true
      }
    }
    eventHandlers.push(eventHandler)
    body.addEventListener('sleep', eventHandler)
  })

  const simulationStart = performance.now()
  let i = 0
  while (numSlept < params.numberOfDice) {
    simulationRecord.push(simulationDiceArray.map(d => [d.position.clone(), d.quaternion.clone()]))
    simulationWorld.step(1 / 60, 1 / 60)
    i++

    // Check for stuck state every stuckDetectionSteps
    if (i % stuckDetectionSteps === 0) {
      const currentPositions = simulationDiceArray.map(d => d.position.clone())
      const currentVelocities = simulationDiceArray.map(d => d.velocity.clone())

      if (lastPositions.length > 0) {
        let allStuck = true
        for (let dIdx = 0; dIdx < simulationDiceArray.length; dIdx++) {
          const positionDelta = currentPositions[dIdx].distanceTo(lastPositions[dIdx])
          const velocityMagnitude = currentVelocities[dIdx].length()

          // If any dice has significant movement or velocity, not stuck
          if (positionDelta > stuckDetectionThreshold || velocityMagnitude > stuckDetectionThreshold) {
            allStuck = false
            break
          }
        }

        if (allStuck && retryCount < 3) {
          console.warn(`Simulation appears stuck after ${i} steps with seed ${seed}, retrying with new seed (attempt ${retryCount + 1})`)
          eventHandlers.map((f, idx) => f && simulationDiceArray[idx].removeEventListener('sleep', f))

          // Generate new seed and retry
          const newSeed = Math.random().toString(36).slice(2)
          return simulateThrow(newSeed, retryCount + 1)
        }
      }

      lastPositions = currentPositions
    }

    if (performance.now() - simulationStart > 1000) {
      console.error(`simulation timed out after ${i} steps, with seed ${seed}`)
      eventHandlers.map((f, i) => f && simulationDiceArray[i].removeEventListener('sleep', f))
      break
    }
  }
  simulationRecord.push(simulationDiceArray.map(d => [d.position.clone(), d.quaternion.clone()]))
  // eslint-disable-next-line no-console
  console.log('simulation took', (performance.now() - simulationStart) / 1000, 'seconds')
  return [rollResult, simulationRecord] as const
}

const storedFrames: string[] = []
;(window as any).storedFrames = storedFrames
function renderSimulation([rollResult, simulationRecord]: ReturnType<typeof simulateThrow>, id: symbol) {
  const start = performance.now()
  storedFrames.length = 0 // Reset stored frames for new simulation

  const renderHelper = () => {
    const now = performance.now()
    const step = ((now - start) / 1000) * 60
    const i = clamp(Math.floor(step), 0, simulationRecord.length - 1)
    const j = Math.ceil(step)

    if (simulationRecord[j]) {
      meshArray.forEach((mesh, idx) => {
        mesh.position.lerpVectors(
          simulationRecord[i][idx][0] as unknown as THREE.Vector3,
          simulationRecord[j][idx][0] as unknown as THREE.Vector3,
          step - i,
        )
        mesh.quaternion.copy(
          simulationRecord[i][idx][1] as unknown as THREE.Quaternion,
        ).slerp(
          new THREE.Quaternion().copy(simulationRecord[j][idx][1] as unknown as THREE.Quaternion),
          step - i,
        )
      })
      if (id === renderId)
        requestAnimationFrame(renderHelper)
    }
    else {
      meshArray.forEach((mesh, idx) => {
        mesh.position.copy(simulationRecord[i][idx][0] as unknown as THREE.Vector3)
        mesh.quaternion.copy(simulationRecord[i][idx][1] as unknown as THREE.Quaternion)
      })

      // Log stored frames count when animation completes
      if (params.storeFrames && storedFrames.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`Stored ${storedFrames.length} frames as base64 PNG strings`)
        // Optionally, you could save storedFrames to localStorage or send to server
        // localStorage.setItem('diceFrames', JSON.stringify(storedFrames))
      }
    }

    if (params.magic)
      meshArray.forEach((mesh, i) => makeDesired(mesh, rollResult[i], params.desiredRolls[i]))

    renderer.render(scene, camera)

    // Store frame as base64 PNG if storeFrames is enabled
    if (params.storeFrames) {
      const canvas = renderer.domElement
      const base64Frame = canvas.toDataURL('image/png')
      storedFrames.push(base64Frame)
    }
  }
  renderHelper()
}

function getFaceUp(euler: CANNON.Vec3) {
  const eps = 0.1
  const isZero = (angle: number) => Math.abs(angle) < eps
  const isHalfPi = (angle: number) => Math.abs(angle - 0.5 * Math.PI) < eps
  const isMinusHalfPi = (angle: number) => Math.abs(0.5 * Math.PI + angle) < eps
  const isPiOrMinusPi = (angle: number) => (Math.abs(Math.PI - angle) < eps || Math.abs(Math.PI + angle) < eps)

  if (isZero(euler.z)) {
    if (isZero(euler.x)) {
      return 1
    }
    else if (isHalfPi(euler.x)) {
      return 4
    }
    else if (isMinusHalfPi(euler.x)) {
      return 3
    }
    else if (isPiOrMinusPi(euler.x)) {
      return 6
    }
    else {
      // landed on edge
      return 0
    }
  }
  else if (isHalfPi(euler.z)) {
    return 2
  }
  else if (isMinusHalfPi(euler.z)) {
    return 5
  }
  else {
    // landed on edge
    return 0
  }
}

function makeDesired(mesh: THREE.Group, actual: number, desired: number) {
  // const euler = new THREE.Euler().setFromQuaternion(mesh.quaternion)
  // console.log(actual, JSON.stringify(euler))
  if (actual === desired)
    return

  const rotationAxis = new THREE.Vector3(1, 0, 0)
  let angle = Math.PI / 2

  // !!! THERE HAS TO BE A BETTER WAY !!!
  if (actual === 1) {
    if (desired === 2)
      rotationAxis.set(0, 0, 1)
    else if (desired === 3)
      rotationAxis.set(-1, 0, 0)
    else if (desired === 4)
      rotationAxis.set(1, 0, 0)
    else if (desired === 5)
      rotationAxis.set(0, 0, -1)
    else if (desired === 6)
      angle = Math.PI
  }
  else if (actual === 2) {
    if (desired === 1) {
      rotationAxis.set(0, 0, -1)
    }
    else if (desired === 3) {
      rotationAxis.set(1, 0, 1)
      angle = Math.PI
    }
    else if (desired === 4) {
      rotationAxis.set(1, 0, -1)
      angle = Math.PI
    }
    else if (desired === 5) {
      rotationAxis.set(0, 0, 1)
      angle = Math.PI
    }
    else if (desired === 6) {
      rotationAxis.set(0, 0, 1)
    }
  }
  else if (actual === 3) {
    if (desired === 1) {
      rotationAxis.set(1, 0, 0)
    }
    else if (desired === 2) {
      rotationAxis.set(1, 0, 1)
      angle = Math.PI
    }
    else if (desired === 4) {
      rotationAxis.set(1, 0, 0)
      angle = Math.PI
    }
    else if (desired === 5) {
      rotationAxis.set(1, 0, -1)
      angle = Math.PI
    }
    else if (desired === 6) {
      rotationAxis.set(-1, 0, 0)
    }
  }
  else if (actual === 4) {
    if (desired === 1) {
      rotationAxis.set(-1, 0, 0)
    }
    else if (desired === 2) {
      rotationAxis.set(1, 0, -1)
      angle = Math.PI
    }
    else if (desired === 3) {
      rotationAxis.set(1, 0, 0)
      angle = Math.PI
    }
    else if (desired === 5) {
      rotationAxis.set(1, 0, 1)
      angle = Math.PI
    }
    else if (desired === 6) {
      rotationAxis.set(1, 0, 0)
    }
  }
  else if (actual === 5) {
    if (desired === 1) {
      rotationAxis.set(0, 0, 1)
    }
    else if (desired === 2) {
      rotationAxis.set(0, 0, 1)
      angle = Math.PI
    }
    else if (desired === 3) {
      rotationAxis.set(1, 0, -1)
      angle = Math.PI
    }
    else if (desired === 4) {
      rotationAxis.set(1, 0, 1)
      angle = Math.PI
    }
    else if (desired === 6) {
      rotationAxis.set(0, 0, -1)
    }
  }
  else if (actual === 6) {
    if (desired === 1) {
      rotationAxis.set(0, 0, 1)
      angle = Math.PI
    }
    else if (desired === 2) {
      rotationAxis.set(0, 0, -1)
    }
    else if (desired === 3) {
      rotationAxis.set(1, 0, 0)
    }
    else if (desired === 4) {
      rotationAxis.set(-1, 0, 0)
    }
    else if (desired === 5) {
      rotationAxis.set(0, 0, 1)
    }
  }

  const rotationQuaternion = new THREE.Quaternion()
  rotationQuaternion.setFromAxisAngle(rotationAxis.normalize(), angle)
  mesh.quaternion.multiply(rotationQuaternion)
}

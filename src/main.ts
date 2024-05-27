import * as CANNON from 'cannon-es'
import * as THREE from 'three'
import seedrandom from 'seedrandom'
import { clamp } from 'three/src/math/MathUtils'
import type { FolderApi } from 'tweakpane'
import { Pane } from 'tweakpane'
import * as BufferGeometryUtils from './BufferGeometryUtils'

const canvasEl = document.querySelector('#canvas')!
const simulationResult = document.querySelector('#simulation-result')!

let renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  diceMesh: THREE.Group,
  simulationWorld: CANNON.World

const pane = new Pane()

const params = {
  numberOfDice: 2,
  segments: 40,
  edgeRadius: 0.07,
  notchRadius: 0.12,
  notchDepth: 0.1,
  desiredRolls: [6, 3],
  magic: false,
  seed: '',
}

const meshArray: THREE.Group[] = []
const simulationDiceArray: CANNON.Body[] = []

initPhysics()
initScene()
initUI()

throwDice(params.seed || undefined)

window.addEventListener('resize', updateSceneSize)

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
  params.desiredRolls = simulationDiceArray.map(() => 1)
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
  floor.receiveShadow = true
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
  let boxGeometry = new THREE.BoxGeometry(1, 1, 1, params.segments, params.segments, params.segments)

  const positionAttr = boxGeometry.attributes.position
  const subCubeHalfSize = 0.5 - params.edgeRadius

  for (let i = 0; i < positionAttr.count; i++) {
    let position = new THREE.Vector3().fromBufferAttribute(positionAttr, i)

    const subCube = new THREE.Vector3(Math.sign(position.x), Math.sign(position.y), Math.sign(position.z)).multiplyScalar(subCubeHalfSize)
    const addition = new THREE.Vector3().subVectors(position, subCube)

    if (Math.abs(position.x) > subCubeHalfSize && Math.abs(position.y) > subCubeHalfSize && Math.abs(position.z) > subCubeHalfSize) {
      addition.normalize().multiplyScalar(params.edgeRadius)
      position = subCube.add(addition)
    }
    else if (Math.abs(position.x) > subCubeHalfSize && Math.abs(position.y) > subCubeHalfSize) {
      addition.z = 0
      addition.normalize().multiplyScalar(params.edgeRadius)
      position.x = subCube.x + addition.x
      position.y = subCube.y + addition.y
    }
    else if (Math.abs(position.x) > subCubeHalfSize && Math.abs(position.z) > subCubeHalfSize) {
      addition.y = 0
      addition.normalize().multiplyScalar(params.edgeRadius)
      position.x = subCube.x + addition.x
      position.z = subCube.z + addition.z
    }
    else if (Math.abs(position.y) > subCubeHalfSize && Math.abs(position.z) > subCubeHalfSize) {
      addition.x = 0
      addition.normalize().multiplyScalar(params.edgeRadius)
      position.y = subCube.y + addition.y
      position.z = subCube.z + addition.z
    }

    const notchWave = (v: number) => {
      v = (1 / params.notchRadius) * v
      v = Math.PI * Math.max(-1, Math.min(1, v))
      return params.notchDepth * (Math.cos(v) + 1.0)
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
  const baseGeometry = new THREE.PlaneGeometry(1 - 2 * params.edgeRadius, 1 - 2 * params.edgeRadius)
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

function throwDice(seed?: string) {
  seed ??= `${Math.random()}`
  renderSimulation(simulateThrow(seed))
}

function simulateThrow(seed?: string) {
  simulationResult.textContent = ''

  const rng = seedrandom(seed ?? Math.random().toString(36).slice(2))
  let numSlept = 0
  const simulationRecord: [CANNON.Vec3, CANNON.Quaternion][][] = []
  const rollResult = simulationDiceArray.map(() => 0)

  simulationDiceArray.forEach((body, dIdx) => {
    body.velocity.setZero()
    body.angularVelocity.setZero()

    body.position = new CANNON.Vec3(dIdx * 1.5, 0, 0)

    const rotation = new THREE.Euler(2 * Math.PI * rng(), 2 * Math.PI * rng(), 2 * Math.PI * rng())
    body.quaternion.copy(new THREE.Quaternion().setFromEuler(rotation) as unknown as CANNON.Quaternion)

    const force = 3 + 5 * rng()
    body.applyImpulse(
      new CANNON.Vec3(-force, force, 0),
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
        body.removeEventListener('sleep', eventHandler)
      }
      else {
        body.allowSleep = true
      }
    }
    body.addEventListener('sleep', eventHandler)
  })

  const simulationStart = performance.now()
  let i = 0
  while (numSlept < params.numberOfDice) {
    simulationRecord.push(simulationDiceArray.map(d => [d.position.clone(), d.quaternion.clone()]))
    simulationWorld.step(1 / 60, 1 / 60)
    i++
    if (performance.now() - simulationStart > 1000) {
      console.error(`simulation timed out after ${i} steps, with seed ${seed}`)
      break
    }
  }
  simulationRecord.push(simulationDiceArray.map(d => [d.position.clone(), d.quaternion.clone()]))
  // eslint-disable-next-line no-console
  console.log('simulation took', (performance.now() - simulationStart) / 1000, 'seconds')
  return [rollResult, simulationRecord] as const
}

function renderSimulation([rollResult, simulationRecord]: ReturnType<typeof simulateThrow>) {
  const start = performance.now()
  const renderHelper = () => {
    const now = performance.now()
    const step = ((now - start) / 1000) * 60
    const i = clamp(Math.floor(step), 0, simulationRecord.length - 1)
    const j = Math.ceil(step)

    if (simulationRecord[j]) {
      meshArray.forEach ((mesh, idx) => {
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
      requestAnimationFrame(renderHelper)
    }
    else {
      meshArray.forEach((mesh, idx) => {
        mesh.position.copy(simulationRecord[i][idx][0] as unknown as THREE.Vector3)
        mesh.quaternion.copy(simulationRecord[i][idx][1] as unknown as THREE.Quaternion)
      })
    }
    if (params.magic)
      meshArray.forEach((mesh, i) => makeDesired(mesh, rollResult[i], params.desiredRolls[i]))

    renderer.render(scene, camera)
  }
  requestAnimationFrame(renderHelper)
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

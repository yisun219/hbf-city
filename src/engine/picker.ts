import * as THREE from 'three'
import type { Registry } from '../core/registry'
import { themed } from '../core/theme'
import type { Bus } from '../core/types'

/* ============================================================================
 * PICKER — hover and click on anything registered.
 *
 * The highlight is a set of corner brackets around the component's live
 * bounds, not an outline pass: it costs one LineSegments draw and follows a
 * die as its stack opens.
 * ==========================================================================*/

export interface Picker {
  group: THREE.Group
  update(): void
  setSelected(id: string | null): void
  setHovered(id: string | null): void
}

const BRACKET_SEGMENTS = 24
const _size = new THREE.Vector3()

function bracketGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BRACKET_SEGMENTS * 2 * 3), 3))
  return g
}

/** Corner brackets: three short edges from each of the eight corners. */
function writeBrackets(geo: THREE.BufferGeometry, box: THREE.Box3, pad: number): void {
  const a = geo.getAttribute('position') as THREE.BufferAttribute
  const min = box.min
  const max = box.max
  const x0 = min.x - pad
  const y0 = min.y - pad * 0.3
  const z0 = min.z - pad
  const x1 = max.x + pad
  const y1 = max.y + pad * 0.6
  const z1 = max.z + pad
  const lx = (x1 - x0) * 0.18
  const ly = (y1 - y0) * 0.22
  const lz = (z1 - z0) * 0.18
  let k = 0
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    a.setXYZ(k++, ax, ay, az)
    a.setXYZ(k++, bx, by, bz)
  }
  for (const cx of [x0, x1]) {
    for (const cy of [y0, y1]) {
      for (const cz of [z0, z1]) {
        const sx = cx === x0 ? 1 : -1
        const sy = cy === y0 ? 1 : -1
        const sz = cz === z0 ? 1 : -1
        seg(cx, cy, cz, cx + sx * lx, cy, cz)
        seg(cx, cy, cz, cx, cy + sy * ly, cz)
        seg(cx, cy, cz, cx, cy, cz + sz * lz)
      }
    }
  }
  a.needsUpdate = true
  geo.computeBoundingSphere()
}

export function createPicker(opts: {
  dom: HTMLElement
  camera: THREE.PerspectiveCamera
  registry: Registry
  bus: Bus
}): Picker {
  const { dom, camera, registry, bus } = opts
  const group = new THREE.Group()
  group.name = 'picker'

  const selMat = new THREE.LineBasicMaterial({ transparent: true, depthTest: false, fog: false })
  const hovMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false, fog: false })
  themed((mode, p) => {
    selMat.color.setHex(p.tsv)
    hovMat.color.setHex(p.ink)
    selMat.opacity = mode === 'night' ? 1 : 0.95
  })
  const sel = new THREE.LineSegments(bracketGeometry(), selMat)
  const hov = new THREE.LineSegments(bracketGeometry(), hovMat)
  sel.renderOrder = 20
  hov.renderOrder = 19
  sel.frustumCulled = false
  hov.frustumCulled = false
  sel.visible = false
  hov.visible = false
  group.add(sel, hov)

  let selected: string | null = null
  let hovered: string | null = null
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const box = new THREE.Box3()
  let pending = false
  let lastX = 0
  let lastY = 0
  let downX = 0
  let downY = 0

  function pick(clientX: number, clientY: number): string | null {
    const r = dom.getBoundingClientRect()
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hits = ray.intersectObjects(registry.roots(), true)
    for (const h of hits) {
      if (!h.object.visible || h.object.userData.noPick) continue
      const def = registry.resolve(h.object, h.instanceId)
      if (def) return def.id
    }
    return null
  }

  dom.addEventListener('pointermove', (e) => {
    lastX = e.clientX
    lastY = e.clientY
    pending = true
  })
  dom.addEventListener('pointerleave', () => {
    bus.emit('hover', { id: null })
  })
  dom.addEventListener('pointerdown', (e) => {
    downX = e.clientX
    downY = e.clientY
  })
  dom.addEventListener('click', (e) => {
    // a drag that ends on the canvas is a pan, not a click
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return
    bus.emit('select', { id: pick(e.clientX, e.clientY) })
  })
  dom.addEventListener('dblclick', (e) => {
    const id = pick(e.clientX, e.clientY)
    if (id) bus.emit('focus', { id })
  })

  function update(): void {
    if (pending) {
      pending = false
      const id = pick(lastX, lastY)
      if (id !== hovered) bus.emit('hover', { id })
    }
    if (selected) {
      const def = registry.get(selected)
      if (def) {
        def.bounds(box)
        writeBrackets(sel.geometry, box, Math.max(1, box.getSize(_size).length() * 0.02))
        sel.visible = true
      }
    } else sel.visible = false
    if (hovered && hovered !== selected) {
      const def = registry.get(hovered)
      if (def) {
        def.bounds(box)
        writeBrackets(hov.geometry, box, Math.max(0.8, box.getSize(_size).length() * 0.015))
        hov.visible = true
      }
    } else hov.visible = false
  }

  return {
    group,
    update,
    setSelected(id) {
      selected = id
    },
    setHovered(id) {
      hovered = id
      dom.style.cursor = id ? 'pointer' : ''
    },
  }
}

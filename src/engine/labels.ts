import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { cssHex } from '../core/theme'
import type { Registry } from '../core/registry'
import type { Bus, ComponentDef } from '../core/types'

/* ============================================================================
 * LABELS — floating name tags, tiered by distance.
 *
 *   tier 0  always shown (GPU, the six stacks)
 *   tier 1  landmarks, shown within a medium range
 *   tier 2  details, shown up close and only when their gate allows it
 *
 * A component's tag sits on top of its live bounds, so a die's tag rides up
 * with the die when its stack opens.
 * ==========================================================================*/

export interface Labels {
  update(camera: THREE.PerspectiveCamera, enabled: boolean): void
  render(scene: THREE.Scene, camera: THREE.Camera): void
  resize(w: number, h: number): void
  setHighlight(id: string | null): void
}

const RANGE: Record<0 | 1 | 2, number> = { 0: Infinity, 1: 820, 2: 330 }
const MAX_VISIBLE = 30

interface Tag {
  def: ComponentDef
  obj: CSS2DObject
  el: HTMLElement
  readout: HTMLElement | null
  shown: boolean
}

const _box = new THREE.Box3()
const _c = new THREE.Vector3()

export function createLabels(root: HTMLElement, registry: Registry, bus: Bus): Labels {
  const css = new CSS2DRenderer({ element: root })
  root.classList.add('labels-root')
  const group = new THREE.Group()
  group.name = 'labels'
  const tags: Tag[] = []
  let highlighted: string | null = null

  for (const def of registry.all()) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `tag tag--t${def.tier}`
    el.dataset.id = def.id
    const dot = document.createElement('span')
    dot.className = 'tag__dot'
    if (def.color !== undefined) dot.style.background = cssHex(def.color)
    const name = document.createElement('span')
    name.className = 'tag__name'
    name.textContent = def.name
    el.append(dot, name)
    let readout: HTMLElement | null = null
    if (def.readout) {
      readout = document.createElement('span')
      readout.className = 'tag__readout'
      el.append(readout)
    }
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      bus.emit('select', { id: def.id })
    })
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      bus.emit('focus', { id: def.id })
    })
    el.addEventListener('pointerenter', () => bus.emit('hover', { id: def.id }))
    el.addEventListener('pointerleave', () => bus.emit('hover', { id: null }))
    const obj = new CSS2DObject(el)
    obj.center.set(0.5, 1.15)
    obj.visible = false
    group.add(obj)
    tags.push({ def, obj, el, readout, shown: false })
  }

  const candidates: { tag: Tag; d: number }[] = []

  function update(camera: THREE.PerspectiveCamera, enabled: boolean): void {
    candidates.length = 0
    for (const tag of tags) {
      const def = tag.def
      if (def.labelAt) def.labelAt(_c)
      else {
        def.bounds(_box)
        _box.getCenter(_c)
        _c.y = _box.max.y
      }
      tag.obj.position.copy(_c)
      const d = camera.position.distanceTo(_c)
      const allowed =
        (enabled || def.id === highlighted) &&
        (def.id === highlighted || (d < RANGE[def.tier] && (def.labelWhen ? def.labelWhen() : true)))
      if (allowed) candidates.push({ tag, d: d * (1 + def.tier * 0.6) })
      else tag.obj.visible = false
    }
    candidates.sort((a, b) => a.d - b.d)
    for (let i = 0; i < candidates.length; i++) {
      const { tag } = candidates[i]
      const show = i < MAX_VISIBLE || tag.def.id === highlighted
      tag.obj.visible = show
      if (show && tag.readout && tag.def.readout) tag.readout.textContent = tag.def.readout()
    }
  }

  function setHighlight(id: string | null): void {
    highlighted = id
    for (const tag of tags) tag.el.classList.toggle('tag--active', tag.def.id === id)
  }

  return {
    update,
    render(scene, camera) {
      if (group.parent !== scene) scene.add(group)
      css.render(scene, camera)
    },
    resize(w, h) {
      css.setSize(w, h)
    },
    setHighlight,
  }
}

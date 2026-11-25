import type * as THREE from 'three'
import type { ComponentDef } from './types'

/**
 * Everything the reader can point at.
 *
 * Whole objects resolve by walking up from the raycast hit to a registered
 * ancestor. Instances of a shared InstancedMesh (core dies, planes' parent
 * dies, GPCs) resolve through `instanceId`, because one mesh draws many
 * components.
 */
export class Registry {
  private byId = new Map<string, ComponentDef>()
  private byObject = new Map<THREE.Object3D, ComponentDef>()
  private byInstance = new Map<THREE.Object3D, Map<number, ComponentDef>>()
  private ordered: ComponentDef[] = []

  register(def: ComponentDef): void {
    if (this.byId.has(def.id)) throw new Error(`duplicate component id "${def.id}"`)
    this.byId.set(def.id, def)
    this.ordered.push(def)
    if (def.instances === undefined) {
      this.byObject.set(def.object, def)
    } else {
      let m = this.byInstance.get(def.object)
      if (!m) this.byInstance.set(def.object, (m = new Map()))
      for (const id of def.instances) m.set(id, def)
    }
  }

  get(id: string): ComponentDef | undefined {
    return this.byId.get(id)
  }

  /** Resolve a raycast hit to the nearest registered component. */
  resolve(obj: THREE.Object3D | null | undefined, instanceId?: number): ComponentDef | undefined {
    let o: THREE.Object3D | null = obj ?? null
    let guard = 0
    while (o && guard++ < 64) {
      if (instanceId !== undefined) {
        const hit = this.byInstance.get(o)?.get(instanceId)
        if (hit) return hit
      }
      const whole = this.byObject.get(o)
      if (whole) return whole
      o = o.parent
    }
    return undefined
  }

  all(): readonly ComponentDef[] {
    return this.ordered
  }

  /** Every pickable root, each listed once. */
  roots(): THREE.Object3D[] {
    const out = new Set<THREE.Object3D>()
    for (const d of this.ordered) out.add(d.object)
    return [...out]
  }

  search(q: string, limit = 12): ComponentDef[] {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const scored: { d: ComponentDef; s: number }[] = []
    for (const d of this.ordered) {
      const name = d.name().toLowerCase()
      let s = -1
      if (name === needle || d.id === needle) s = 1000
      else if (name.startsWith(needle)) s = 500 - name.length
      else if (name.includes(needle)) s = 250 - name.length
      else if (d.role().toLowerCase().includes(needle)) s = 100
      if (s > 0) scored.push({ d, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, limit).map((x) => x.d)
  }
}

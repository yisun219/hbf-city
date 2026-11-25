import * as THREE from 'three'
import { themed } from '../core/theme'
import type { PaletteKey } from '../core/theme'

/* ============================================================================
 * FLOW MATERIAL — traffic drawn as light pulses running along a conductor.
 *
 * Per instance:
 *   aFlow  0..1 utilisation of the link this instance stands for
 *   aDir   +1 / -1: which way the pulses travel along the axis
 * Pulse density and brightness follow aFlow, so an idle link is dark and a
 * saturated one is a continuous stream. Pulses move in world units, so links
 * of different lengths read at the same speed.
 * ==========================================================================*/

export interface FlowMaterial {
  material: THREE.MeshStandardMaterial
  /** advance the pulses; call once per frame with wall-clock seconds */
  tick(dt: number): void
}

export function createFlowMaterial(opts: {
  base: PaletteKey
  pulse: PaletteKey
  axis: 'x' | 'y'
  spacing: number
  speed: number
  nightBase?: number
  dayGlow?: number
}): FlowMaterial {
  const uniforms = {
    uTime: { value: 0 },
    uPulse: { value: new THREE.Color() },
    uGain: { value: 1 },
  }
  const material = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 })
  material.customProgramCacheKey = () => `hbfcity.flow.${opts.axis}`
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aFlow;
attribute float aDir;
varying float vFlow;
varying float vFlowCoord;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec4 hbfW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  hbfW = instanceMatrix * hbfW;
  #endif
  hbfW = modelMatrix * hbfW;
  vFlow = aFlow;
  vFlowCoord = hbfW.${opts.axis} * aDir;
}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec3 uPulse;
uniform float uGain;
varying float vFlow;
varying float vFlowCoord;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float f = fract(vFlowCoord / ${opts.spacing.toFixed(3)} - uTime * ${(opts.speed / opts.spacing).toFixed(4)});
  float w = mix(0.06, 0.42, clamp(vFlow, 0.0, 1.0));
  float dash = smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(w, w + 0.08, f));
  totalEmissiveRadiance += uPulse * dash * clamp(vFlow * 1.6, 0.0, 1.0) * uGain;
}`,
      )
  }
  themed((mode, p, air) => {
    const base = p[opts.base]
    if (mode === 'night') {
      material.color.setHex(base).multiplyScalar(opts.nightBase ?? 0.3)
      material.emissive.setHex(base)
      material.emissiveIntensity = 0.12
      uniforms.uGain.value = air.glow * 0.85
    } else {
      material.color.setHex(base)
      material.emissive.setHex(0)
      material.emissiveIntensity = 0
      uniforms.uGain.value = opts.dayGlow ?? 0.9
    }
    uniforms.uPulse.value.setHex(p[opts.pulse])
  })
  return {
    material,
    tick(dt) {
      uniforms.uTime.value = (uniforms.uTime.value + dt) % 10000
    },
  }
}

/** Attach the per-instance flow attributes to an instanced geometry. */
export function addFlowAttributes(geo: THREE.BufferGeometry, count: number, dir: (i: number) => number): {
  flow: THREE.InstancedBufferAttribute
} {
  const flow = new THREE.InstancedBufferAttribute(new Float32Array(count), 1)
  flow.setUsage(THREE.DynamicDrawUsage)
  const d = new Float32Array(count)
  for (let i = 0; i < count; i++) d[i] = dir(i)
  geo.setAttribute('aFlow', flow)
  geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(d, 1))
  return { flow }
}

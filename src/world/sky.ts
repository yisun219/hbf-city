import * as THREE from 'three'
import { atmosphere, themed } from '../core/theme'
import { makeRng } from '../core/util'

/* ============================================================================
 * SKY — a gradient dome and, at night, a star field. It is also the source
 * the renderer captures for image-based lighting, so silicon picks up a soft
 * reflection of it.
 * ==========================================================================*/

export function createSky(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'sky'

  const uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
  }
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(9000, 48, 24),
    new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGround;
        uniform vec3 uGlow;
        varying vec3 vDir;
        void main() {
          float y = vDir.y;
          vec3 c = y > 0.0
            ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.55))
            : mix(uHorizon, uGround, smoothstep(0.0, 0.25, -y));
          // a soft band of light along the horizon on the key-light side
          float side = 0.5 + 0.5 * dot(normalize(vDir.xz + 1e-4), normalize(vec2(-0.6, -0.8)));
          c += uGlow * exp(-abs(y) * 9.0) * side * 0.35;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  )
  dome.name = 'sky.dome'
  dome.frustumCulled = false
  dome.renderOrder = -10
  group.add(dome)

  // Stars: a fixed seed, so the night sky is the same every visit.
  const rng = makeRng(0x57a5)
  const n = 1800
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const u = rng()
    const v = rng() * 0.92 + 0.06
    const th = u * Math.PI * 2
    const ph = Math.acos(1 - v)
    pos[i * 3] = Math.sin(ph) * Math.cos(th) * 8500
    pos[i * 3 + 1] = Math.cos(ph) * 8500
    pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * 8500
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const starMat = new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: 0xbfd4ff, fog: false, transparent: true, opacity: 0.8, depthWrite: false })
  const stars = new THREE.Points(starGeo, starMat)
  stars.name = 'sky.stars'
  stars.frustumCulled = false
  group.add(stars)

  themed((_mode, p) => {
    const air = atmosphere()
    uniforms.uZenith.value.setHex(p.skyZenith)
    uniforms.uHorizon.value.setHex(p.skyHorizon)
    uniforms.uGround.value.setHex(p.fog)
    uniforms.uGlow.value.setHex(p.skyGlow)
    stars.visible = air.stars
  })
  return group
}

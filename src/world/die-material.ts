import * as THREE from 'three'
import { HBF } from '../core/hbf-spec'
import { themed } from '../core/theme'
import { DIE_PLAN } from './layout'
import { ATLAS } from './occupancy'

/* ============================================================================
 * CORE-DIE SURFACE — the floor plan of a NAND die, drawn in the fragment
 * shader so that all 16,384 blocks of a die cost one box.
 *
 * Top face, in footprint fractions (u from the GPU-facing edge, v from north):
 *   seal ring around the edge
 *   power-TSV rows along both long edges        (copper dots)
 *   signal-TSV strip along the centre           (ice-blue dots)
 *   32 planes in two rows of 16; each plane has a word-line staircase at both
 *   u-ends and 512 block strips between them, separated by the slits that
 *   divide 3D-NAND blocks. Block colour comes from the occupancy atlas.
 *
 * Side faces show silicon with the bond line between the array wafer and the
 * CMOS wafer it is bonded to (CBA; FlashAccel Fig. 3a).
 *
 * Built on MeshStandardMaterial so shadows, fog, tone mapping and the
 * environment light behave exactly as on every other surface.
 * ==========================================================================*/

const f = (x: number): string => x.toFixed(5)

const FRAGMENT_DECLS = /* glsl */ `
uniform sampler2D uOcc;
uniform sampler2D uAct;
uniform vec3 uTop;
uniform vec3 uSilicon;
uniform vec3 uSeal;
uniform vec3 uCopper;
uniform vec3 uTsv;
uniform vec3 uSel;
uniform float uGlow;
uniform float uNight;
uniform float uSelDie;
varying vec3 vHbfObj;
varying vec3 vHbfObjN;
varying float vHbfDie;
varying float vHbfFlip;

const float HBF_COLS = ${f(HBF.planesPerDie / 2)};
const float HBF_PLANES = ${f(HBF.planesPerDie)};
const float HBF_BLOCKS = ${f(HBF.blocksPerPlane)};
const vec2 HBF_ATLAS = vec2(${f(ATLAS.width)}, ${f(ATLAS.height)});
const float HBF_ATLAS_ROW = ${f(ATLAS.diesPerRow)};
const float HBF_SEAL = ${f(DIE_PLAN.seal)};
const float HBF_PR0 = ${f(DIE_PLAN.powerRow[0])};
const float HBF_PR1 = ${f(DIE_PLAN.powerRow[1])};
const float HBF_SPINE = ${f(DIE_PLAN.spineHalf)};
const float HBF_PU0 = ${f(DIE_PLAN.planeU[0])};
const float HBF_PU1 = ${f(DIE_PLAN.planeU[1])};
const float HBF_R0V0 = ${f(DIE_PLAN.rowV[0][0])};
const float HBF_R0V1 = ${f(DIE_PLAN.rowV[0][1])};
const float HBF_R1V0 = ${f(DIE_PLAN.rowV[1][0])};
const float HBF_R1V1 = ${f(DIE_PLAN.rowV[1][1])};
const float HBF_GUTTER = ${f(DIE_PLAN.gutter)};
const float HBF_STAIR = ${f(DIE_PLAN.staircase)};

float hbfBand(float lo, float hi, float x, float w) {
  return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

void hbfPlan(inout vec3 albedo, inout vec3 emis, inout float rough, inout float metal) {
  if (vHbfObjN.y < -0.5) {
    albedo = uSilicon * 0.35;
    return;
  }
  if (vHbfObjN.y < 0.5) {
    float h = vHbfObj.y + 0.5;
    float fw = max(fwidth(h), 1e-4);
    float bondLine = 1.0 - smoothstep(0.0, fw * 1.4, abs(h - 0.5));
    float rim = smoothstep(1.0 - fw * 2.5, 1.0, h);
    albedo = mix(uSilicon, uSeal, max(bondLine * 0.6, rim * 0.5));
    rough = 0.38;
    metal = 0.5;
    return;
  }

  float u = 0.5 + vHbfFlip * vHbfObj.x;
  float v = vHbfObj.z + 0.5;
  float wu = max(fwidth(u), 1e-5);
  float wv = max(fwidth(v), 1e-5);
  bool selected = abs(vHbfDie - uSelDie) < 0.5;
  // per-die activity: r = read utilisation, g = program, b = erase
  vec4 act = texture(uAct, vec2((vHbfDie + 0.5) / ${f(96)}, 0.5));

  albedo = uTop;
  rough = 0.52;
  metal = 0.3;

  // Seal ring.
  float inner = hbfBand(HBF_SEAL, 1.0 - HBF_SEAL, u, wu) * hbfBand(HBF_SEAL, 1.0 - HBF_SEAL, v, wv);
  albedo = mix(uSeal, albedo, inner);
  // the selected die's seal ring carries the selection colour, softly
  if (selected) emis += uSel * (1.0 - inner) * mix(0.3, 0.55, uNight);
  // (erases flash the erased block rows themselves, in the atlas)

  // Power-TSV rows along both long edges.
  float inU = hbfBand(HBF_PU0, HBF_PU1, u, wu);
  float rowN = hbfBand(HBF_PR0, HBF_PR1, v, wv);
  float rowS = hbfBand(1.0 - HBF_PR1, 1.0 - HBF_PR0, v, wv);
  float pRow = max(rowN, rowS) * inU;
  if (pRow > 0.001) {
    float c = v < 0.5 ? 0.5 * (HBF_PR0 + HBF_PR1) : 1.0 - 0.5 * (HBF_PR0 + HBF_PR1);
    float cu = u * 96.0;
    vec2 cell = vec2(fract(cu) - 0.5, (v - c) / (HBF_PR1 - HBF_PR0) * 1.2);
    float fwc = fwidth(cu);
    float dotv = 1.0 - smoothstep(0.28, 0.28 + fwc * 1.5 + 0.02, length(cell));
    float far = smoothstep(0.4, 1.0, fwc);
    float k = pRow * mix(dotv, 0.22, far);
    albedo = mix(albedo, uCopper, k);
    metal = mix(metal, 0.9, k);
    rough = mix(rough, 0.3, k);
  }

  // Signal-TSV strip along the centre.
  float spine = hbfBand(0.5 - HBF_SPINE, 0.5 + HBF_SPINE, v, wv) * inU;
  if (spine > 0.001) {
    float sv = (v - (0.5 - HBF_SPINE)) / (2.0 * HBF_SPINE);
    float cu = u * 150.0;
    vec2 cell = vec2(fract(cu) - 0.5, fract(sv * 4.0) - 0.5);
    float fwc = fwidth(cu);
    float dotv = 1.0 - smoothstep(0.22, 0.22 + fwc * 1.5 + 0.02, length(cell));
    float far = smoothstep(0.4, 1.0, fwc);
    float k = mix(dotv, 0.2, far);
    vec3 strip = mix(uTop * 0.6, mix(uCopper, uTsv, 0.55 + 0.45 * uNight), k);
    albedo = mix(albedo, strip, spine);
    // the strip carries every read and program to and from the base die
    emis += uTsv * (uGlow * 0.14 + (0.1 + 0.3 * uNight) * (act.r * 0.5 + act.g)) * spine * k;
    metal = mix(metal, 0.75, spine * k);
  }

  // Planes: two rows of HBF_COLS columns.
  float uu = (u - HBF_PU0) / (HBF_PU1 - HBF_PU0) * HBF_COLS;
  float wuu = max(fwidth(uu), 1e-5);
  float col = floor(uu);
  float pu = uu - col;
  float row = v < 0.5 ? 0.0 : 1.0;
  float r0 = row < 0.5 ? HBF_R0V0 : HBF_R1V0;
  float r1 = row < 0.5 ? HBF_R0V1 : HBF_R1V1;
  // Blocks count outward from the TSV strip in both rows, so the rows mirror.
  float pv = row < 0.5 ? (r1 - v) / (r1 - r0) : (v - r0) / (r1 - r0);
  float wpv = max(fwidth(pv), 1e-5);
  float inPlane = hbfBand(HBF_GUTTER, 1.0 - HBF_GUTTER, pu, wuu)
    * hbfBand(0.0, 1.0, pv, wpv)
    * step(0.0, uu) * step(uu, HBF_COLS);
  if (inPlane > 0.001) {
    float plane = row * HBF_COLS + col;
    float ap = (pu - HBF_GUTTER) / (1.0 - 2.0 * HBF_GUTTER);
    float wap = wuu / (1.0 - 2.0 * HBF_GUTTER);
    float arrayZone = hbfBand(HBF_STAIR, 1.0 - HBF_STAIR, ap, wap);

    // Word-line staircase: terraces stepping down toward the array.
    float sd = ap < 0.5 ? ap / HBF_STAIR : (1.0 - ap) / HBF_STAIR;
    float step6 = floor(clamp(sd, 0.0, 0.999) * 7.0);
    vec3 stair = mix(uSeal * 0.9, uTop * 1.15, mod(step6, 2.0) * 0.6 + step6 / 14.0);

    // Block strips from the occupancy atlas.
    float bc = clamp(pv, 0.0, 0.99999) * HBF_BLOCKS;
    float gx = mod(vHbfDie, HBF_ATLAS_ROW);
    float gy = floor(vHbfDie / HBF_ATLAS_ROW);
    vec2 tc = vec2((gx * HBF_PLANES + plane + 0.5) / HBF_ATLAS.x, (gy * HBF_BLOCKS + bc) / HBF_ATLAS.y);
    float ty = (gy * HBF_BLOCKS + pv * HBF_BLOCKS) / HBF_ATLAS.y;
    vec4 occ = textureGrad(uOcc, tc, vec2(0.0, dFdx(ty)), vec2(0.0, dFdy(ty)));

    float fb = fract(bc);
    float wb = max(fwidth(bc), 1e-5);
    float slit = 1.0 - smoothstep(0.0, wb * 1.25, min(fb, 1.0 - fb));
    float slitFade = 1.0 - smoothstep(0.3, 0.75, wb);
    float s = slit * slitFade;

    vec3 cellDay = occ.rgb * (1.0 - 0.5 * s);
    vec3 cellNight = occ.rgb * 0.16 * (1.0 - 0.6 * s);
    vec3 arrayAlb = mix(cellDay, cellNight, uNight);
    vec3 arrayEmis = occ.rgb * occ.a * uGlow * (1.0 - 0.75 * s);
    if (selected) arrayEmis *= 1.25;
    // planes being sensed shimmer faintly with the die's read utilisation
    arrayEmis += uTsv * act.r * 0.07 * uNight;
    arrayAlb = mix(arrayAlb, vec3(1.0), act.r * 0.06 * (1.0 - uNight));

    // Plane outline.
    float edgeU = min(ap, 1.0 - ap) / max(wap, 1e-5);
    float edgeV = min(pv, 1.0 - pv) / wpv;
    float outline = 1.0 - smoothstep(0.6, 1.6, min(edgeU, edgeV));

    vec3 planeAlb = mix(stair, arrayAlb, arrayZone);
    planeAlb = mix(planeAlb, uSeal, outline * 0.5);
    albedo = mix(albedo, planeAlb, inPlane);
    emis += arrayEmis * arrayZone * inPlane;
    rough = mix(rough, mix(0.42, 0.6, arrayZone), inPlane);
    metal = mix(metal, mix(0.55, 0.15, arrayZone), inPlane);
  }
}
`

export interface CoreDieMaterial {
  material: THREE.MeshStandardMaterial
  /** highlight one die (global index) or -1 */
  setSelectedDie(global: number): void
}

export function createCoreDieMaterial(occupancy: THREE.Texture, activity: THREE.Texture): CoreDieMaterial {
  const uniforms = {
    uOcc: { value: occupancy },
    uAct: { value: activity },
    uTop: { value: new THREE.Color() },
    uSilicon: { value: new THREE.Color() },
    uSeal: { value: new THREE.Color() },
    uCopper: { value: new THREE.Color() },
    uTsv: { value: new THREE.Color() },
    uSel: { value: new THREE.Color() },
    uGlow: { value: 0 },
    uNight: { value: 1 },
    uSelDie: { value: -1 },
  }
  const material = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 })
  material.name = 'hbfcity.coreDie'
  material.customProgramCacheKey = () => 'hbfcity.coreDie.v3'
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aDie;
attribute float aFlip;
varying vec3 vHbfObj;
varying vec3 vHbfObjN;
varying float vHbfDie;
varying float vHbfFlip;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vHbfObj = position;
vHbfObjN = normal;
vHbfDie = aDie;
vHbfFlip = aFlip;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLS}`)
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
{
  vec3 hbfAlb = diffuseColor.rgb;
  vec3 hbfEm = vec3(0.0);
  float hbfR = roughnessFactor;
  float hbfM = metalnessFactor;
  hbfPlan(hbfAlb, hbfEm, hbfR, hbfM);
  diffuseColor.rgb = hbfAlb;
  totalEmissiveRadiance += hbfEm;
  roughnessFactor = hbfR;
  metalnessFactor = hbfM;
}`,
      )
  }

  themed((mode, p, air) => {
    uniforms.uTop.value.setHex(p.siliconTop)
    uniforms.uSilicon.value.setHex(p.silicon)
    uniforms.uSeal.value.setHex(p.seal)
    uniforms.uCopper.value.setHex(p.copper)
    uniforms.uTsv.value.setHex(p.tsv)
    uniforms.uSel.value.setHex(p.kv)
    uniforms.uGlow.value = air.glow
    uniforms.uNight.value = mode === 'night' ? 1 : 0
  })

  return {
    material,
    setSelectedDie(global: number) {
      uniforms.uSelDie.value = global
    },
  }
}

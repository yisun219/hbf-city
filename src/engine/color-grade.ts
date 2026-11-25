import * as THREE from 'three'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export const GOLDEN_HOUR_GRADE = {
  lift: 0.008,
  gamma: 0.96,
  gain: 1.035,
  midtoneSaturation: 1.07,
  vignette: 0.075,
} as const

/** Extra ground-layer haze never replaces more than this much scene colour. */
export const HEIGHT_FOG_MAX = 0.2

const GRADE_UNIFORMS = /* glsl */ `
uniform float pgGradeEnabled;
uniform float pgGradeLift;
uniform float pgGradeGamma;
uniform float pgGradeGain;
uniform float pgGradeSaturation;
uniform float pgGradeVignette;

vec3 pgGoldenHourGrade( vec3 color, vec2 uv ) {
	color = max( color + vec3( pgGradeLift ), vec3( 0.0 ) );
	color = pow( color, vec3( 1.0 / pgGradeGamma ) ) * pgGradeGain;

	float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	float mids = smoothstep( 0.02, 0.18, luma ) * ( 1.0 - smoothstep( 0.65, 1.20, luma ) );
	color = mix( vec3( luma ), color, mix( 1.0, pgGradeSaturation, mids ) );

	vec2 frame = uv * 2.0 - 1.0;
	float edge = smoothstep( 0.30, 1.35, dot( frame, frame ) );
	return max( color * ( 1.0 - pgGradeVignette * edge ), vec3( 0.0 ) );
}
`

const AERIAL_UNIFORMS = /* glsl */ `
uniform sampler2D pgSceneDepth;
uniform float pgAerialEnabled;
uniform float pgHeightFogDensity;
uniform float pgHeightFogFalloff;
uniform float pgHeightFogMax;
uniform vec3 pgHeightFogColor;
uniform vec3 pgCameraPosition;
uniform mat4 pgProjectionInverse;
uniform mat4 pgCameraWorld;

float pgHeightFogAmount( float distanceToEye, float eyeY, float surfaceY ) {
  float eyeDensity = exp( - max( 0.0, eyeY ) * pgHeightFogFalloff );
  float surfaceDensity = exp( - max( 0.0, surfaceY ) * pgHeightFogFalloff );
  float averageDensity = ( eyeDensity + surfaceDensity * 2.0 ) / 3.0;
  return min( pgHeightFogMax, 1.0 - exp( - distanceToEye * pgHeightFogDensity * averageDensity ) );
}

vec3 pgApplyHeightFog( vec3 color, vec2 uv ) {
  float depth = texture2D( pgSceneDepth, uv ).x;
  if ( depth >= 0.999999 ) return color;
  vec4 clip = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  vec4 view = pgProjectionInverse * clip;
  view /= max( view.w, 0.000001 );
  vec3 world = ( pgCameraWorld * view ).xyz;
  float amount = pgHeightFogAmount( length( world - pgCameraPosition ), pgCameraPosition.y, world.y );
  return mix( color, pgHeightFogColor, amount );
}
`

const SAMPLE_ANCHOR = 'uniform sampler2D tDiffuse;'
const GRADE_ANCHOR = '\n\t\t\t// tone mapping'

interface SceneDepthSource {
  sceneDepthTexture: THREE.DepthTexture | null
}

/**
 * OutputPass with mode-aware aerial perspective and the daylight grade fused
 * ahead of tone mapping. It costs no second fullscreen pass or render target.
 */
export class GoldenHourOutputPass extends OutputPass {
  private readonly camera: THREE.PerspectiveCamera | null
  private readonly depthSource: SceneDepthSource | null

  constructor(camera: THREE.PerspectiveCamera | null = null, depthSource: SceneDepthSource | null = null) {
    super()
    this.camera = camera
    this.depthSource = depthSource
    this.uniforms.pgGradeEnabled = { value: 0 }
    this.uniforms.pgGradeLift = { value: GOLDEN_HOUR_GRADE.lift }
    this.uniforms.pgGradeGamma = { value: GOLDEN_HOUR_GRADE.gamma }
    this.uniforms.pgGradeGain = { value: GOLDEN_HOUR_GRADE.gain }
    this.uniforms.pgGradeSaturation = { value: GOLDEN_HOUR_GRADE.midtoneSaturation }
    this.uniforms.pgGradeVignette = { value: GOLDEN_HOUR_GRADE.vignette }
    this.uniforms.pgSceneDepth = { value: null }
    this.uniforms.pgAerialEnabled = { value: 0 }
    this.uniforms.pgHeightFogDensity = { value: 0 }
    this.uniforms.pgHeightFogFalloff = { value: 0.02 }
    this.uniforms.pgHeightFogMax = { value: 0 }
    this.uniforms.pgHeightFogColor = { value: new THREE.Color() }
    this.uniforms.pgCameraPosition = { value: new THREE.Vector3() }
    this.uniforms.pgProjectionInverse = { value: new THREE.Matrix4() }
    this.uniforms.pgCameraWorld = { value: new THREE.Matrix4() }
    this.material.fragmentShader = this.material.fragmentShader
      .replace(SAMPLE_ANCHOR, `${SAMPLE_ANCHOR}\n${GRADE_UNIFORMS}\n${AERIAL_UNIFORMS}`)
      .replace(
        GRADE_ANCHOR,
        '\n\t\t\tif ( pgAerialEnabled > 0.5 ) gl_FragColor.rgb = pgApplyHeightFog( gl_FragColor.rgb, vUv );' +
          '\n\t\t\tif ( pgGradeEnabled > 0.5 ) gl_FragColor.rgb = pgGoldenHourGrade( gl_FragColor.rgb, vUv );' +
          GRADE_ANCHOR,
      )
    this.material.name = 'PGSimCity.GoldenHourOutput'
  }

  setDaylight(enabled: boolean): void {
    this.uniforms.pgGradeEnabled.value = enabled ? 1 : 0
  }

  setAerialPerspective(color: number, density: number, falloff: number, strength: number): void {
    this.uniforms.pgHeightFogColor.value.setHex(color)
    this.uniforms.pgHeightFogDensity.value = density * strength
    this.uniforms.pgHeightFogFalloff.value = falloff
    this.uniforms.pgHeightFogMax.value = HEIGHT_FOG_MAX * strength
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const depth = this.depthSource?.sceneDepthTexture ?? null
    const camera = this.camera
    this.uniforms.pgAerialEnabled.value = depth && camera && this.uniforms.pgHeightFogDensity.value > 0 ? 1 : 0
    if (depth && camera) {
      this.uniforms.pgSceneDepth.value = depth
      this.uniforms.pgCameraPosition.value.copy(camera.position)
      this.uniforms.pgProjectionInverse.value.copy(camera.projectionMatrixInverse)
      this.uniforms.pgCameraWorld.value.copy(camera.matrixWorld)
    }
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
  }
}

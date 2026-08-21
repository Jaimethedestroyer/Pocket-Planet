/**
 * Post-processing pipeline.
 *
 *   scene ──► HDR colour + depth
 *          ──► composite   (ocean, atmosphere, stars)
 *          ──► bright pass ──► blur H ──► blur V   (bloom, quarter resolution)
 *          ──► final       (bloom add, ACES tone map, vignette, dither)
 *
 * Written by hand rather than assembled from three's example passes: the
 * composite step needs the scene depth texture, which EffectComposer does not
 * expose, and the whole chain is only four draws so there is little to gain
 * from a general framework.
 */

import * as THREE from 'three';
import { GLSL_ACES } from '../shaderLib';
import { compositeFragment, compositeVertex } from './compositeShader';
import type { SharedUniforms } from '../environment';
import type { QualitySettings } from '../../planet/config';

const passVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const brightFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee, so a highlight ramps into bloom instead of popping into it.
  float soft = clamp(luma - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float weight = max(soft, luma - uThreshold) / max(luma, 1e-5);
  gl_FragColor = vec4(c * weight, 1.0);
}
`;

const blurFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform vec2 uDirection;
varying vec2 vUv;

// Nine-tap gaussian folded into five bilinear samples.
const float O1 = 1.3846153846;
const float O2 = 3.2307692308;
const float W0 = 0.2270270270;
const float W1 = 0.3162162162;
const float W2 = 0.0702702703;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb * W0;
  c += texture2D(tDiffuse, vUv + uDirection * O1).rgb * W1;
  c += texture2D(tDiffuse, vUv - uDirection * O1).rgb * W1;
  c += texture2D(tDiffuse, vUv + uDirection * O2).rgb * W2;
  c += texture2D(tDiffuse, vUv - uDirection * O2).rgb * W2;
  gl_FragColor = vec4(c, 1.0);
}
`;

const finalFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uVignette;
varying vec2 vUv;

${GLSL_ACES}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c += texture2D(tBloom, vUv).rgb * uBloomStrength;
  c *= uExposure;

  c = acesFilm(c);

  // Vignette, kept subtle: it should read as a lens, not a frame.
  vec2 d = vUv - 0.5;
  float vig = 1.0 - dot(d, d) * uVignette;
  c *= vig;

  // Ordered dither breaks up banding in the sky gradient, which is the one
  // place an 8-bit framebuffer visibly gives up.
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (dither - 0.5) / 255.0;

  // Manual sRGB encode: a raw ShaderMaterial writing to the default
  // framebuffer does not get three's automatic colour space conversion.
  vec3 srgb = mix(
    c * 12.92,
    1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c));

  gl_FragColor = vec4(srgb, 1.0);
}
`;

function fullscreenTriangle(): THREE.BufferGeometry {
  // One oversized triangle rather than two: no diagonal seam, no wasted
  // fragments along it, and one fewer vertex to transform.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return geom;
}

export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  private sceneTarget!: THREE.WebGLRenderTarget;
  private compositeTarget!: THREE.WebGLRenderTarget;
  private bloomA!: THREE.WebGLRenderTarget;
  private bloomB!: THREE.WebGLRenderTarget;

  private compositeMaterial: THREE.ShaderMaterial;
  private brightMaterial: THREE.ShaderMaterial;
  private blurMaterial: THREE.ShaderMaterial;
  private finalMaterial: THREE.ShaderMaterial;

  private quality: QualitySettings;
  private width = 1;
  private height = 1;

  private invProjView = new THREE.Matrix4();
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private upAxis = new THREE.Vector3();
  private tmpBasis = new THREE.Vector3();
  /** Camera altitude above sea level, set each frame by the app. */
  camAltitude = 1000;

  constructor(
    renderer: THREE.WebGLRenderer,
    shared: SharedUniforms,
    quality: QualitySettings,
  ) {
    this.renderer = renderer;
    this.quality = quality;

    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'composite',
      vertexShader: compositeVertex,
      fragmentShader: compositeFragment,
      defines: {
        PRIMARY_STEPS: quality.atmosphereSteps,
        LIGHT_STEPS: quality.atmosphereLightSteps,
        CLOUD_STEPS: quality.cloudSteps,
        CLOUD_LIGHT_STEPS: quality.cloudLightSteps,
      },
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        uInvProjView: { value: new THREE.Matrix4() },
        uCameraPos: shared.uCameraPos,
        uCameraForward: { value: new THREE.Vector3() },
        uCameraRight: { value: new THREE.Vector3() },
        uCameraUp: { value: new THREE.Vector3() },
        uNear: { value: 1 },
        uFar: { value: 1000 },
        uSunDir: shared.uSunDir,
        // Top-of-atmosphere sunlight: this pass does its own extinction.
        uSunColor: shared.uSolarColor,
        uSunIntensity: shared.uSolarIntensity,
        uPlanetRadius: shared.uPlanetRadius,
        uAtmosphereRadius: shared.uAtmosphereRadius,
        uTime: shared.uTime,
        // Scattering coefficients and scale heights are owned by Environment,
        // which varies them with camera altitude and keeps the sunlight colour
        // it computes consistent with the sky drawn here.
        uBetaRayleigh: shared.uBetaRayleigh,
        uBetaMie: shared.uBetaMie,
        uScaleHeightR: shared.uScaleHeightR,
        uScaleHeightM: shared.uScaleHeightM,
        // With the coefficients above at their physical values, this is the
        // only artistic dial: how bright the sky reads against lit ground.
        uAtmosphereStrength: { value: 3.4 },
        uProjScale: { value: 1000 },
        uTanHalfFov: { value: 0.5 },
        // Above the mountains, which top out at 26 m. Set lower, the deck
        // intersects the terrain and reads as fog caught on a hillside rather
        // than as weather overhead.
        uCloudBottom: { value: 34 },
        uCloudTop: { value: 66 },
        uCloudCoverage: { value: 0.46 },
        uCloudDensity: { value: quality.clouds ? 1.0 : 0.0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.brightMaterial = new THREE.ShaderMaterial({
      name: 'bloom-bright',
      vertexShader: passVertex,
      fragmentShader: brightFragment,
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 1.05 },
        uKnee: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      name: 'bloom-blur',
      vertexShader: passVertex,
      fragmentShader: blurFragment,
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.finalMaterial = new THREE.ShaderMaterial({
      name: 'final',
      vertexShader: passVertex,
      fragmentShader: finalFragment,
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        uBloomStrength: { value: quality.bloom ? 0.42 : 0 },
        uExposure: { value: 1.0 },
        uVignette: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(fullscreenTriangle(), this.finalMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.setSize(1, 1);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    this.sceneTarget?.dispose();
    this.compositeTarget?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();

    const depth = new THREE.DepthTexture(this.width, this.height);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    // Half float throughout: the sun glint and the bright limb routinely
    // exceed 1.0, and clipping them before tone mapping loses the highlight
    // roll-off that makes the image read as photographic.
    const hdr = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    } as const;

    this.sceneTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
      ...hdr,
      depthTexture: depth,
    });
    this.compositeTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
      ...hdr,
      depthBuffer: false,
    });

    const bw = Math.max(1, this.width >> 2);
    const bh = Math.max(1, this.height >> 2);
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, { ...hdr, depthBuffer: false });
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, { ...hdr, depthBuffer: false });
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    this.compositeMaterial.uniforms.uProjScale.value = this.height / (2 * tanHalfFov);
    this.compositeMaterial.uniforms.uTanHalfFov.value = tanHalfFov;


    // 1. Scene into the HDR target.
    r.setRenderTarget(this.sceneTarget);
    r.clear();
    r.render(scene, camera);

    // 2. Composite: ocean, atmosphere, stars.
    const u = this.compositeMaterial.uniforms;
    this.invProjView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    u.uInvProjView.value.copy(this.invProjView);
    camera.getWorldDirection(this.forward);
    u.uCameraForward.value.copy(this.forward);
    // The camera's screen basis, so the water pass can turn a world-space
    // surface slope into a screen-space refraction offset.
    camera.matrixWorld.extractBasis(this.right, this.upAxis, this.tmpBasis);
    u.uCameraRight.value.copy(this.right);
    u.uCameraUp.value.copy(this.upAxis);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.tScene.value = this.sceneTarget.texture;
    u.tDepth.value = this.sceneTarget.depthTexture;
    this.blit(this.compositeMaterial, this.compositeTarget);

    // 3. Bloom.
    if (this.quality.bloom) {
      this.brightMaterial.uniforms.tDiffuse.value = this.compositeTarget.texture;
      this.blit(this.brightMaterial, this.bloomA);

      const bw = this.bloomA.width;
      const bh = this.bloomA.height;
      this.blurMaterial.uniforms.tDiffuse.value = this.bloomA.texture;
      this.blurMaterial.uniforms.uDirection.value.set(1 / bw, 0);
      this.blit(this.blurMaterial, this.bloomB);

      this.blurMaterial.uniforms.tDiffuse.value = this.bloomB.texture;
      this.blurMaterial.uniforms.uDirection.value.set(0, 1 / bh);
      this.blit(this.blurMaterial, this.bloomA);
    }

    // 4. Tone map to the screen.
    this.finalMaterial.uniforms.tDiffuse.value = this.compositeTarget.texture;
    this.finalMaterial.uniforms.tBloom.value = this.bloomA.texture;
    this.blit(this.finalMaterial, null);
    r.setRenderTarget(null);
  }

  setExposure(value: number): void {
    this.finalMaterial.uniforms.uExposure.value = value;
  }

  setBloom(strength: number): void {
    this.finalMaterial.uniforms.uBloomStrength.value = strength;
  }

  /** 0 is a clear sky, 1 is overcast. */
  setCloudCoverage(value: number): void {
    this.compositeMaterial.uniforms.uCloudCoverage.value = value;
  }

  /** Tuning knobs, exposed for the in-app debug panel. */
  get atmosphere(): { [key: string]: THREE.IUniform } {
    return this.compositeMaterial.uniforms;
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.compositeTarget.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.compositeMaterial.dispose();
    this.brightMaterial.dispose();
    this.blurMaterial.dispose();
    this.finalMaterial.dispose();
    this.quad.geometry.dispose();
  }
}

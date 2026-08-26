/**
 * Banners over the civic buildings.
 *
 * Whose town this is has always been readable from the territory field and, up
 * close, from a stripe of the polity's colour worked into the buildings
 * themselves. Neither of those is any use at the altitude a town is actually
 * looked at from — the field is under the roofs, and the stripe is four pixels.
 * A pennant on a mast is: it stands clear of the skyline, it is the one thing
 * up there that moves, and it changes colour the century the town changes
 * hands, which is exactly what conquest should look like.
 *
 * Two cards per banner and they are not the crossed pair the trees use. One is
 * the cloth, billboarded to the camera about the mast's own axis; the other is
 * the mast, which is a thin dark quad and needs no texture at all. Putting them
 * in one geometry keeps a skyline of flags at one draw call.
 *
 * The sheet's pennant is crimson wool with its folds painted in. It is tinted
 * by holding those folds and replacing the hue, so a blue kingdom's flag still
 * has the same cloth in it rather than becoming a flat blue triangle.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import { spriteSheets } from './sheets';
import type { BannerPlacement } from './plan';

/** Ranged with the buildings they stand on: a flag with no town under it is a mistake. */
export const BANNER_NEAR = 520;
export const BANNER_FAR = 900;

/** Metres. Thin enough to read as timber, thick enough not to alias away. */
const MAST_WIDTH = 0.16;

const vertexShader = /* glsl */ `
attribute vec3 iOrigin;
attribute float iMast;
attribute float iSize;
attribute float iPhase;
attribute vec3 iColor;

uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec2 vUv;
varying float vCloth;
varying vec3 vColor;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  vec3 up = normalize(iOrigin);
  vec3 toCamera = cameraPosition - iOrigin;
  float dist = length(toCamera);
  vec3 forward = toCamera / max(dist, 1e-4);
  vec3 right = cross(up, forward);
  if (dot(right, right) < 1e-6) right = vec3(1.0, 0.0, 0.0);
  right = normalize(right);

  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  float mast = iMast * grow;
  float size = iSize * grow;

  // position.z picks the card: 0 is the cloth, 1 is the mast.
  float cloth = 1.0 - position.z;
  vec2 quad = position.xy;

  vec3 world;
  if (cloth > 0.5) {
    // The pennant flies from the top of the mast, hoist against it and the fly
    // running out to one side. The wind travels along it rather than moving the
    // whole thing at once, which is the difference between cloth and cardboard.
    float t = uTime * 2.6 + iPhase * 17.0;
    float along = quad.x + 0.5;
    float ripple = sin(t - along * 5.5) * 0.13 * along * size;
    world = iOrigin
      + up * (mast + (quad.y - 1.0) * size + ripple)
      + right * (along * size * 1.7);
    vUv = vec2(along, quad.y);
  } else {
    world = iOrigin
      + up * (quad.y * mast)
      + right * (quad.x * ${MAST_WIDTH.toFixed(3)} * grow);
    vUv = vec2(0.0, 0.0);
  }

  vCloth = cloth;
  vColor = iColor;
  vUp = up;
  vWorldPos = world;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D tSheet;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying float vCloth;
varying vec3 vColor;
varying vec3 vUp;
varying vec3 vWorldPos;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 albedo;
  if (vCloth > 0.5) {
    vec4 texel = texture2D(tSheet, vUv);
    if (texel.a < 0.4) discard;
    // Hold the weave and the folds, replace the dye. The sheet is a dark
    // crimson, so its luminance sits around a fifth; scaling by five puts a
    // lit fold at one and leaves the shadowed side of the cloth below it.
    float fold = clamp(dot(texel.rgb, LUMA) * 5.0, 0.10, 1.35);
    albedo = vColor * fold;
  } else {
    albedo = vec3(0.13, 0.10, 0.08);
  }

  // Lit as a standing surface rather than a flat card, for the same reason a
  // person is: a skyline of flags all at one brightness gives the trick away.
  vec3 up = normalize(vUp);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(V * 0.7 + up * 0.3);

  float diffuse = clamp((dot(N, uSunDir) + 0.3) / 1.3, 0.0, 1.0);
  vec3 lit = albedo * uSunColor * uSunIntensity * diffuse;
  lit += albedo * uAmbientColor * 1.0;

  gl_FragColor = vec4(lit, 1.0);
}
`;

export class BannerLayer {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;

  private capacity = 0;
  private count = 0;
  private origin!: THREE.InstancedBufferAttribute;
  private mast!: THREE.InstancedBufferAttribute;
  private size!: THREE.InstancedBufferAttribute;
  private phase!: THREE.InstancedBufferAttribute;
  private color!: THREE.InstancedBufferAttribute;

  constructor(shared: SharedUniforms) {
    this.geometry = new THREE.InstancedBufferGeometry();
    const p: number[] = [];
    const idx: number[] = [];
    for (let card = 0; card < 2; card++) {
      const base = card * 4;
      p.push(-0.5, 0, card, 0.5, 0, card, 0.5, 1, card, -0.5, 1, card);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    this.geometry.setIndex(idx);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      name: 'banners',
      vertexShader,
      fragmentShader,
      uniforms: {
        tSheet: { value: spriteSheets().banner },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uTime: shared.uTime,
        uFadeNear: { value: BANNER_NEAR },
        uFadeFar: { value: BANNER_FAR },
      },
      // Alpha-tested rather than blended, so a flag writes depth and the one
      // behind it sorts correctly against it.
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'banners';
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.grow(128);
  }

  private grow(capacity: number): void {
    const previous = this.capacity > 0
      ? {
          origin: (this.origin.array as Float32Array).slice(0, this.count * 3),
          mast: (this.mast.array as Float32Array).slice(0, this.count),
          size: (this.size.array as Float32Array).slice(0, this.count),
          phase: (this.phase.array as Float32Array).slice(0, this.count),
          color: (this.color.array as Float32Array).slice(0, this.count * 3),
        }
      : null;

    this.capacity = capacity;
    const make = (items: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.origin = make(3);
    this.mast = make(1);
    this.size = make(1);
    this.phase = make(1);
    this.color = make(3);
    this.geometry.setAttribute('iOrigin', this.origin);
    this.geometry.setAttribute('iMast', this.mast);
    this.geometry.setAttribute('iSize', this.size);
    this.geometry.setAttribute('iPhase', this.phase);
    this.geometry.setAttribute('iColor', this.color);

    if (previous) {
      (this.origin.array as Float32Array).set(previous.origin);
      (this.mast.array as Float32Array).set(previous.mast);
      (this.size.array as Float32Array).set(previous.size);
      (this.phase.array as Float32Array).set(previous.phase);
      (this.color.array as Float32Array).set(previous.color);
    }
  }

  begin(): void {
    this.count = 0;
  }

  /** `color` is the polity's, and it is the whole point of the object. */
  add(b: BannerPlacement, color: [number, number, number]): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    const o = this.origin.array as Float32Array;
    o[i * 3] = b.origin.x;
    o[i * 3 + 1] = b.origin.y;
    o[i * 3 + 2] = b.origin.z;
    (this.mast.array as Float32Array)[i] = b.mast;
    (this.size.array as Float32Array)[i] = b.size;
    (this.phase.array as Float32Array)[i] = b.phase;
    const c = this.color.array as Float32Array;
    c[i * 3] = color[0];
    c[i * 3 + 1] = color[1];
    c[i * 3 + 2] = color[2];
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    this.origin.needsUpdate = true;
    this.mast.needsUpdate = true;
    this.size.needsUpdate = true;
    this.phase.needsUpdate = true;
    this.color.needsUpdate = true;
  }

  setRange(near: number, far: number): void {
    this.material.uniforms.uFadeNear.value = near;
    this.material.uniforms.uFadeFar.value = far;
  }

  get instanceCount(): number {
    return this.count;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

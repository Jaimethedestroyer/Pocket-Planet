/**
 * Fire, and the smoke that comes off it.
 *
 * Night used to be one thing everywhere: every settlement glowed out of its
 * windows, scaled by an era constant, so a primitive village read as a dim
 * modern town rather than as a handful of fires in the dark. A hut has no
 * glazing, and a civilization that has not invented the lamp should read as
 * sparks scattered on a hillside.
 *
 * So there are four things on the sheet and they are drawn by one layer:
 * campfire, torch, brazier, and a chimney plume. The first three are the light;
 * the fourth is lit *by* it and by the sun, which is why they share a mesh but
 * not a blend.
 *
 * **One material for both.** Premultiplied blending — `src * 1 + dst * (1 - a)`
 * — is additive when the fragment writes alpha zero and an ordinary composite
 * when it writes real alpha. A flame therefore adds its own light to whatever
 * is behind it and never darkens it, while a plume covers what it drifts across
 * — out of one draw call, with no second pool of instance buffers.
 *
 * **The flicker is in the shape.** The sheet is four separate objects rather
 * than four frames of one, so there is nothing to play; and a fire that only
 * pulses in brightness reads as a blinking light rather than as burning. The
 * vertex shader stretches, narrows and leans each flame on its own clock, which
 * at the size these are actually seen is what sells it.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import { FIRE_CELLS, spriteSheets } from './sheets';
import type { FirePlacement } from './plan';

export const FIRE_NEAR = 420;
export const FIRE_FAR = 780;

const vertexShader = /* glsl */ `
attribute vec3 iOrigin;
attribute float iSize;
attribute float iKind;
attribute float iPhase;

uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;
uniform float uCells;

varying vec2 vUv;
varying float vKind;
varying float vFlicker;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  vec3 up = normalize(iOrigin);
  vec3 toCamera = cameraPosition - iOrigin;
  float dist = length(toCamera);
  vec3 forward = toCamera / max(dist, 1e-4);
  // Rolled to the surface for the same reason a person is: a fire on a hillside
  // stands up out of the hill rather than lying over as the camera tilts.
  vec3 right = cross(up, forward);
  if (dot(right, right) < 1e-6) right = vec3(1.0, 0.0, 0.0);
  right = normalize(right);

  float flame = iKind < 2.5 ? 1.0 : 0.0;
  // Three frequencies rather than one. A single sine is a heartbeat; the sum of
  // three that do not divide into each other never visibly repeats.
  float t = uTime * mix(2.2, 6.4, flame) + iPhase * 41.0;
  float wob = sin(t) * 0.5 + sin(t * 2.31 + 1.7) * 0.32 + sin(t * 4.73 + 0.4) * 0.18;

  float tall = 1.0 + wob * mix(0.09, 0.17, flame);
  float wide = 1.0 + wob * mix(0.07, -0.10, flame);
  float lean = wob * mix(0.20, 0.04, flame);

  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  float size = iSize * grow;

  vec2 quad = position.xy;
  vec3 world = iOrigin
    + right * ((quad.x * wide + lean * quad.y) * size)
    + up * (quad.y * tall * size);

  vUv = vec2((iKind + quad.x + 0.5) / uCells, quad.y);
  vKind = iKind;
  // Brightness rides the same wobble as the shape, a little behind it.
  vFlicker = (0.80 + 0.20 * sin(t * 1.13 + 1.9) + 0.10 * wob) * grow;
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
varying float vKind;
varying float vFlicker;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  vec4 texel = texture2D(tSheet, vUv);
  if (texel.a < 0.02) discard;

  // The same daylight term the windows use, so a fire and a lit window come up
  // together at dusk instead of one leading the other by a quarter hour.
  float daylight = clamp(dot(normalize(vUp), uSunDir) * 2.4 + 0.3, 0.0, 1.0);
  float night = 1.0 - daylight;

  if (vKind > 2.5) {
    // A plume is lit, not emissive, and it is thin: half its painted alpha is
    // enough to read as smoke and little enough to keep the roof under it.
    vec3 lit = texel.rgb * (uSunColor * uSunIntensity * 0.5 * daylight + uAmbientColor * 1.2);
    float a = texel.a * 0.38 * vFlicker;
    gl_FragColor = vec4(lit * a, a);
    return;
  }

  // Fire is the light, which makes this the one texture in the game that is
  // allowed to carry baked illumination. Alpha stays at zero so the blend is a
  // pure add: a flame never darkens the wall behind it, and the bright pass
  // turns whatever comes out of here into the glare, so nothing paints a halo.
  float strength = (0.6 + night * 3.0) * vFlicker;
  gl_FragColor = vec4(texel.rgb * texel.a * strength, 0.0);
}
`;

export class FireLayer {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;

  private capacity = 0;
  private count = 0;
  private origin!: THREE.InstancedBufferAttribute;
  private size!: THREE.InstancedBufferAttribute;
  private kind!: THREE.InstancedBufferAttribute;
  private phase!: THREE.InstancedBufferAttribute;

  constructor(shared: SharedUniforms) {
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      name: 'fires',
      vertexShader,
      fragmentShader,
      uniforms: {
        tSheet: { value: spriteSheets().fire },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uTime: shared.uTime,
        uFadeNear: { value: FIRE_NEAR },
        uFadeFar: { value: FIRE_FAR },
        uCells: { value: FIRE_CELLS },
      },
      transparent: true,
      // Premultiplied "over". See the note at the top of the file: this is what
      // lets one material be additive for a flame and a composite for smoke.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // Tested against the world so a fire behind a wall is behind it, but not
      // written, because two flames overlapping must both be visible.
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'fires';
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.grow(512);
  }

  private grow(capacity: number): void {
    const previous = this.capacity > 0
      ? {
          origin: (this.origin.array as Float32Array).slice(0, this.count * 3),
          size: (this.size.array as Float32Array).slice(0, this.count),
          kind: (this.kind.array as Float32Array).slice(0, this.count),
          phase: (this.phase.array as Float32Array).slice(0, this.count),
        }
      : null;

    this.capacity = capacity;
    const make = (items: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.origin = make(3);
    this.size = make(1);
    this.kind = make(1);
    this.phase = make(1);
    this.geometry.setAttribute('iOrigin', this.origin);
    this.geometry.setAttribute('iSize', this.size);
    this.geometry.setAttribute('iKind', this.kind);
    this.geometry.setAttribute('iPhase', this.phase);

    if (previous) {
      (this.origin.array as Float32Array).set(previous.origin);
      (this.size.array as Float32Array).set(previous.size);
      (this.kind.array as Float32Array).set(previous.kind);
      (this.phase.array as Float32Array).set(previous.phase);
    }
  }

  begin(): void {
    this.count = 0;
  }

  add(f: FirePlacement): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    const o = this.origin.array as Float32Array;
    o[i * 3] = f.origin.x;
    o[i * 3 + 1] = f.origin.y;
    o[i * 3 + 2] = f.origin.z;
    (this.size.array as Float32Array)[i] = f.size;
    (this.kind.array as Float32Array)[i] = f.kind;
    (this.phase.array as Float32Array)[i] = f.phase;
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    this.origin.needsUpdate = true;
    this.size.needsUpdate = true;
    this.kind.needsUpdate = true;
    this.phase.needsUpdate = true;
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

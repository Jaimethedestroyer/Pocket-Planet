/**
 * Vegetation: trees, crops and scrub, as crossed quads.
 *
 * Two cards at right angles, which is the old middle ground and still the right
 * one. A single card has to turn to face the camera, and anything rooted in the
 * ground that turns as you orbit it reads instantly as wrong. Two crossed cards
 * do not turn at all: they hold their silhouette from every angle, they self-
 * occlude, and they cost eight triangles against a model's several hundred.
 *
 * The cards themselves are pre-rendered plants — see sheets.ts — so unlike
 * everything else here the texture carries finished colour rather than a mask.
 *
 * Lighting foliage by its face normal is the mistake that makes crossed quads
 * look like cardboard: half the tree is lit and half is black, along a hard
 * vertical seam. Bending the normal towards the surface up-vector — and adding
 * a transmission term for light coming *through* the canopy — is what turns
 * two flat cards into something that reads as a mass of leaves.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import { spriteSheets } from './sheets';
import type { PropPlacement } from './plan';

export const PROP_NEAR = 320;
export const PROP_FAR = 620;

const vertexShader = /* glsl */ `
attribute vec3 iOrigin;
attribute float iRot;
attribute float iSize;
attribute float iKind;
attribute vec3 iTint;

uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec2 vUv;
varying vec3 vTint;
varying vec3 vNormal;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  vec3 up = normalize(iOrigin);
  vec3 ref = abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 east = normalize(cross(ref, up));
  vec3 north = cross(up, east);

  // position.z selects the card: 0 is the first, 1 the second, at right angles.
  float card = position.z;
  float angle = iRot + card * 1.5707963;
  float c = cos(angle);
  float s = sin(angle);
  // Negated for the same handedness reason as the building basis.
  vec3 right = -(east * c + north * s);
  vec3 fwd = -east * s + north * c;

  float dist = length(cameraPosition - iOrigin);
  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  float size = iSize * grow;

  vec2 quad = position.xy;
  vec3 local = right * (quad.x * size) + up * (quad.y * size);

  // Wind. Only the top of the card moves, and the phase comes from the world
  // position, so a whole orchard sways as a field rather than in lockstep.
  float sway = sin(uTime * 1.15 + iOrigin.x * 0.6 + iOrigin.z * 0.43) * 0.045 * quad.y * size;
  local += right * sway;

  vec3 world = iOrigin + local;

  // Atlas: 0 broadleaf, 1 crop, 2 conifer, 3 scrub, on a two by two grid.
  // The texture is flipped on upload, so the canvas's top row is v in [0.5, 1].
  float col = floor(iKind * 0.5);
  float row = mod(iKind, 2.0);
  vUv = vec2(
    col * 0.5 + (quad.x + 0.5) * 0.5,
    (row < 0.5 ? 0.5 : 0.0) + quad.y * 0.5);

  vTint = iTint;
  vNormal = normalize(fwd);
  vUp = up;
  vWorldPos = world;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D tAtlas;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying vec3 vTint;
varying vec3 vNormal;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  vec4 tex = texture2D(tAtlas, vUv);
  if (tex.a < 0.42) discard;

  // The sheet is finished art rather than a mask, so this is albedo. The tint
  // is a modulation about one — a little drier here, a little lusher there —
  // which is what stops a wood reading as one photograph printed nine hundred
  // times, without making every tree on the planet the same green.
  vec3 albedo = tex.rgb * vTint;
  // Canopy density, for the light that comes *through* the leaves.
  float mass = dot(tex.rgb, vec3(0.2126, 0.7152, 0.0722));

  vec3 up = normalize(vUp);
  // Bend the card's normal towards up. A flat card lit by its own normal is
  // half black; a canopy is not.
  vec3 N = normalize(mix(normalize(vNormal), up, 0.62));
  if (dot(N, cameraPosition - vWorldPos) < 0.0) N = normalize(mix(-normalize(vNormal), up, 0.62));

  float ndl = dot(N, uSunDir);
  float diffuse = clamp((ndl + 0.28) / 1.28, 0.0, 1.0);
  vec3 lit = albedo * uSunColor * uSunIntensity * diffuse;
  lit += albedo * uAmbientColor * (0.6 + 0.4 * dot(N, up));

  // Transmission: leaves are thin, so the sun behind a canopy comes through it.
  vec3 V = normalize(cameraPosition - vWorldPos);
  float through = pow(max(0.0, dot(-V, uSunDir)), 3.0);
  lit += albedo * uSunColor * uSunIntensity * through * 0.9 * mass;

  gl_FragColor = vec4(lit, 1.0);
}
`;

export class PropLayer {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;

  private capacity = 0;
  private count = 0;
  private origin!: THREE.InstancedBufferAttribute;
  private rot!: THREE.InstancedBufferAttribute;
  private size!: THREE.InstancedBufferAttribute;
  private kind!: THREE.InstancedBufferAttribute;
  private tint!: THREE.InstancedBufferAttribute;

  constructor(shared: SharedUniforms) {
    this.geometry = new THREE.InstancedBufferGeometry();
    // Two quads, distinguished by z: the vertex shader turns that into a
    // ninety-degree rotation rather than a position.
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
      name: 'vegetation',
      vertexShader,
      fragmentShader,
      uniforms: {
        tAtlas: { value: spriteSheets().vegetation },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uTime: shared.uTime,
        uFadeNear: { value: PROP_NEAR },
        uFadeFar: { value: PROP_FAR },
      },
      // Alpha-tested rather than blended: foliage has to write depth, or every
      // tree behind another tree sorts wrong.
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'vegetation';
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.grow(1024);
  }

  private grow(capacity: number): void {
    const previous = this.capacity > 0
      ? {
          origin: (this.origin.array as Float32Array).slice(0, this.count * 3),
          rot: (this.rot.array as Float32Array).slice(0, this.count),
          size: (this.size.array as Float32Array).slice(0, this.count),
          kind: (this.kind.array as Float32Array).slice(0, this.count),
          tint: (this.tint.array as Float32Array).slice(0, this.count * 3),
        }
      : null;

    this.capacity = capacity;
    const make = (items: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.origin = make(3);
    this.rot = make(1);
    this.size = make(1);
    this.kind = make(1);
    this.tint = make(3);
    this.geometry.setAttribute('iOrigin', this.origin);
    this.geometry.setAttribute('iRot', this.rot);
    this.geometry.setAttribute('iSize', this.size);
    this.geometry.setAttribute('iKind', this.kind);
    this.geometry.setAttribute('iTint', this.tint);

    if (previous) {
      (this.origin.array as Float32Array).set(previous.origin);
      (this.rot.array as Float32Array).set(previous.rot);
      (this.size.array as Float32Array).set(previous.size);
      (this.kind.array as Float32Array).set(previous.kind);
      (this.tint.array as Float32Array).set(previous.tint);
    }
  }

  begin(): void {
    this.count = 0;
  }

  add(p: PropPlacement): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    const o = this.origin.array as Float32Array;
    o[i * 3] = p.origin.x;
    o[i * 3 + 1] = p.origin.y;
    o[i * 3 + 2] = p.origin.z;
    (this.rot.array as Float32Array)[i] = p.rot;
    (this.size.array as Float32Array)[i] = p.size;
    (this.kind.array as Float32Array)[i] = p.kind;
    const t = this.tint.array as Float32Array;
    t[i * 3] = p.tint[0];
    t[i * 3 + 1] = p.tint[1];
    t[i * 3 + 2] = p.tint[2];
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    this.origin.needsUpdate = true;
    this.rot.needsUpdate = true;
    this.size.needsUpdate = true;
    this.kind.needsUpdate = true;
    this.tint.needsUpdate = true;
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

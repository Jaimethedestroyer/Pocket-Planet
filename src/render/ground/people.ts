/**
 * People, as animated billboards.
 *
 * This is the one place in the world where a billboard is the *right* answer
 * rather than a compromise. A person is thirty pixels tall at the closest the
 * camera ever gets, and roughly symmetric about their own vertical axis, so a
 * card that turns to face you is indistinguishable from a model that does not —
 * and it costs two triangles instead of six hundred.
 *
 * They walk a real route rather than shuffling in place: each person is given
 * two points on a street and ping-pongs between them, so the position is a lerp
 * of two points that are both *on* the terrain. Walking along a straight tangent
 * instead would sink them into the first hill they crossed.
 *
 * Everything is on the GPU. The CPU uploads a person once and never touches
 * them again; time drives the position, the frame of the walk cycle and which
 * way they are facing.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import { WALK_FRAMES, peopleAtlas } from './textures';
import type { PersonPlacement } from './plan';

export const PEOPLE_NEAR = 120;
export const PEOPLE_FAR = 260;

/** A person, in metres. The planet is small; they are not. */
const PERSON_HEIGHT = 1.75;
const PERSON_WIDTH = 1.05;

const vertexShader = /* glsl */ `
attribute vec3 iFrom;
attribute vec3 iTo;
attribute float iPhase;
attribute float iSpeed;
attribute vec3 iSkin;
attribute vec3 iCloth;

uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;
uniform float uFrames;

varying vec2 vUv;
varying vec3 vSkin;
varying vec3 vCloth;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  // Ping-pong along the route. The triangle wave gives a constant walking
  // speed with a turn at each end, which is what a street looks like.
  float span = distance(iFrom, iTo);
  float cycle = uTime * iSpeed / max(span, 1.0) + iPhase;
  float saw = fract(cycle);
  float t = abs(saw * 2.0 - 1.0);
  float direction = saw < 0.5 ? -1.0 : 1.0;

  vec3 foot = mix(iFrom, iTo, t);
  vec3 up = normalize(foot);

  vec3 toCamera = cameraPosition - foot;
  float dist = length(toCamera);
  vec3 forward = toCamera / max(dist, 1e-4);
  // Rolled to the surface, not to the screen: a person standing on a hillside
  // stands up out of it, and does not lie over as the camera tilts. Looking
  // straight down makes the cross product degenerate, so fall back to the
  // route's own direction — at which point they are a pixel anyway.
  vec3 right = cross(up, forward);
  if (dot(right, right) < 1e-6) right = normalize(iTo - iFrom);
  right = normalize(right);

  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  vec2 quad = position.xy;
  vec3 world = foot
    + right * (quad.x * ${PERSON_WIDTH.toFixed(3)} * grow)
    + up * (quad.y * ${PERSON_HEIGHT.toFixed(3)} * grow);

  // Which way they are walking decides which way the sprite faces. Comparing
  // the direction of travel against the camera's right gives that with no
  // per-instance state at all.
  vec3 travel = normalize(iTo - iFrom) * direction;
  float facing = dot(travel, right) < 0.0 ? -1.0 : 1.0;

  // The walk cycle runs on its own clock, at roughly one stride a second,
  // rather than on the route clock — a person crossing a long street should not
  // stride more slowly than one crossing a short one.
  float frame = floor(fract(uTime * iSpeed * 0.85 + iPhase * 7.0) * uFrames);
  float u = (quad.x * facing + 0.5);
  vUv = vec2((frame + u) / uFrames, quad.y);

  vSkin = iSkin;
  vCloth = iCloth;
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
varying vec3 vSkin;
varying vec3 vCloth;
varying vec3 vUp;
varying vec3 vWorldPos;

void main() {
  vec4 mask = texture2D(tAtlas, vUv);
  if (mask.a < 0.4) discard;

  // Red is clothes, green is skin, blue is hair. One atlas, everybody.
  float total = max(mask.r + mask.g + mask.b, 1e-3);
  vec3 albedo =
    (vCloth * mask.r + vSkin * mask.g + vec3(0.09, 0.07, 0.06) * mask.b) / total;

  // Lit as a standing cylinder rather than as a flat card: mostly facing the
  // viewer, tilted a quarter of the way towards the sky. Lighting a billboard
  // by its true normal makes every person in a crowd the same brightness,
  // which is the single thing that gives sprites away.
  vec3 up = normalize(vUp);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(V * 0.75 + up * 0.25);

  float ndl = dot(N, uSunDir);
  float diffuse = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
  vec3 lit = albedo * uSunColor * uSunIntensity * diffuse;
  lit += albedo * uAmbientColor * 0.9;

  gl_FragColor = vec4(lit, 1.0);
}
`;

export class PeopleLayer {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;
  private atlas: THREE.CanvasTexture;

  private capacity = 0;
  private count = 0;
  private from!: THREE.InstancedBufferAttribute;
  private to!: THREE.InstancedBufferAttribute;
  private phase!: THREE.InstancedBufferAttribute;
  private speed!: THREE.InstancedBufferAttribute;
  private skin!: THREE.InstancedBufferAttribute;
  private cloth!: THREE.InstancedBufferAttribute;

  private scratch = new THREE.Vector3();

  constructor(shared: SharedUniforms) {
    this.atlas = peopleAtlas();

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3),
    );
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      name: 'people',
      vertexShader,
      fragmentShader,
      uniforms: {
        tAtlas: { value: this.atlas },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uTime: shared.uTime,
        uFadeNear: { value: PEOPLE_NEAR },
        uFadeFar: { value: PEOPLE_FAR },
        uFrames: { value: WALK_FRAMES },
      },
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'people';
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    this.grow(256);
  }

  private grow(capacity: number): void {
    const keep = this.capacity > 0
      ? {
          from: (this.from.array as Float32Array).slice(0, this.count * 3),
          to: (this.to.array as Float32Array).slice(0, this.count * 3),
          phase: (this.phase.array as Float32Array).slice(0, this.count),
          speed: (this.speed.array as Float32Array).slice(0, this.count),
          skin: (this.skin.array as Float32Array).slice(0, this.count * 3),
          cloth: (this.cloth.array as Float32Array).slice(0, this.count * 3),
        }
      : null;

    this.capacity = capacity;
    const make = (items: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.from = make(3);
    this.to = make(3);
    this.phase = make(1);
    this.speed = make(1);
    this.skin = make(3);
    this.cloth = make(3);
    this.geometry.setAttribute('iFrom', this.from);
    this.geometry.setAttribute('iTo', this.to);
    this.geometry.setAttribute('iPhase', this.phase);
    this.geometry.setAttribute('iSpeed', this.speed);
    this.geometry.setAttribute('iSkin', this.skin);
    this.geometry.setAttribute('iCloth', this.cloth);

    if (keep) {
      (this.from.array as Float32Array).set(keep.from);
      (this.to.array as Float32Array).set(keep.to);
      (this.phase.array as Float32Array).set(keep.phase);
      (this.speed.array as Float32Array).set(keep.speed);
      (this.skin.array as Float32Array).set(keep.skin);
      (this.cloth.array as Float32Array).set(keep.cloth);
    }
  }

  begin(): void {
    this.count = 0;
  }

  /** `cloth` is the polity's colour: a crowd reads as whose crowd it is. */
  add(p: PersonPlacement, cloth: [number, number, number]): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;

    const half = p.span * 0.5;
    const f = this.from.array as Float32Array;
    const t = this.to.array as Float32Array;
    this.scratch.copy(p.origin).addScaledVector(p.along, -half);
    f[i * 3] = this.scratch.x;
    f[i * 3 + 1] = this.scratch.y;
    f[i * 3 + 2] = this.scratch.z;
    this.scratch.copy(p.origin).addScaledVector(p.along, half);
    t[i * 3] = this.scratch.x;
    t[i * 3 + 1] = this.scratch.y;
    t[i * 3 + 2] = this.scratch.z;

    (this.phase.array as Float32Array)[i] = p.phase;
    (this.speed.array as Float32Array)[i] = p.speed;
    const s = this.skin.array as Float32Array;
    s[i * 3] = p.tint[0];
    s[i * 3 + 1] = p.tint[1];
    s[i * 3 + 2] = p.tint[2];
    const c = this.cloth.array as Float32Array;
    // Muted towards the polity's colour rather than saturated with it: a street
    // of people in pure flag colours reads as a parade.
    c[i * 3] = cloth[0] * 0.45 + 0.16;
    c[i * 3 + 1] = cloth[1] * 0.45 + 0.16;
    c[i * 3 + 2] = cloth[2] * 0.45 + 0.16;
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    this.from.needsUpdate = true;
    this.to.needsUpdate = true;
    this.phase.needsUpdate = true;
    this.speed.needsUpdate = true;
    this.skin.needsUpdate = true;
    this.cloth.needsUpdate = true;
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
    this.atlas.dispose();
  }
}

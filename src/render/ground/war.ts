/**
 * What a war looks like from the ground.
 *
 * The simulation has always known that two states are at war; the planet has
 * never shown it. The chronicle would say the Hefaith Clans had fallen on the
 * Kingdom of Pipouku and the border would sit there, unbothered, in exactly the
 * colours it had the century before.
 *
 * Two things fix most of that, and both are drawn here:
 *
 * **The smoke column** is the one that matters, because it is legible from the
 * altitude wars are actually watched from. A settlement on the front line burns
 * for as long as the war lasts, and a burning town is visible from a kilometre
 * up where a soldier is not visible from ten metres.
 *
 * **The skirmish** — arrows on a ballistic arc, and the dust where they land —
 * only reads in the last hundred metres of a descent, which is why it is the
 * cheaper of the two by an order of magnitude. Each arrow is one instance
 * uploaded once and never touched again: the flight, the stretch along the
 * velocity, the impact and the wait before the next shot are all a function of
 * time and a per-instance phase, so a siege costs nothing per frame.
 *
 * Who is besieged is decided in detail.ts, from the war the simulation is
 * already running. Nothing here knows what a polity is.
 */

import * as THREE from 'three';
import type { SharedUniforms } from '../environment';
import { IMPACT_FRAMES, SMOKE_FRAMES, spriteSheets } from './sheets';

/** Smoke reads from far higher up than anything else in the ground detail. */
export const SMOKE_NEAR = 950;
export const SMOKE_FAR = 1700;

/** The skirmish is a close-range luxury and is ranged like the people are. */
export const SIEGE_NEAR = 190;
export const SIEGE_FAR = 420;

/** One burning building's worth of smoke. */
export interface SmokePlacement {
  /** World position of the root of the column. */
  origin: THREE.Vector3;
  /** Metres tall at its fullest. */
  size: number;
  /** Offsets the stage cycle, so a row of fires is not one fire repeated. */
  phase: number;
}

/** One repeating shot: an arrow out, and the dust where it lands. */
export interface ShotPlacement {
  /** Where it is loosed from. */
  from: THREE.Vector3;
  /** Where it comes down. */
  to: THREE.Vector3;
  /** How high the arc rises above the straight line, in metres. */
  arc: number;
  /** Shots per second. */
  rate: number;
  phase: number;
}

// --- Smoke ------------------------------------------------------------------

const smokeVertex = /* glsl */ `
attribute vec3 iOrigin;
attribute float iSize;
attribute float iPhase;

uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;

varying vec2 vUv;
varying float vStage;
varying float vUp;
varying vec3 vSurfaceUp;
varying vec3 vWorldPos;

void main() {
  vec3 up = normalize(iOrigin);
  vec3 toCamera = cameraPosition - iOrigin;
  float dist = length(toCamera);
  vec3 forward = toCamera / max(dist, 1e-4);
  vec3 right = cross(up, forward);
  if (dot(right, right) < 1e-6) right = vec3(1.0, 0.0, 0.0);
  right = normalize(right);

  // A column of smoke leans, and the lean travels up it rather than the whole
  // plume swinging like a pendulum.
  vec2 quad = position.xy;
  float t = uTime * 0.31 + iPhase * 13.0;
  float lean = (sin(t) * 0.6 + sin(t * 1.7 + 2.1) * 0.4) * 0.34 * quad.y * quad.y;

  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, dist);
  float size = iSize * grow;

  vec3 world = iOrigin
    + right * ((quad.x * (0.30 + quad.y * 0.55) + lean) * size)
    + up * (quad.y * size);

  // The four cells are stages of one column building, not frames of a loop, so
  // they are cross-faded rather than cut between: at this size a hard change of
  // silhouette every second reads as strobing, not as fire.
  vStage = fract(uTime * 0.07 + iPhase) * ${SMOKE_FRAMES}.0;
  vUv = vec2(quad.x + 0.5, quad.y);
  vUp = quad.y;
  vSurfaceUp = up;
  vWorldPos = world;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const smokeFragment = /* glsl */ `
precision highp float;

uniform sampler2D tSheet;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying float vStage;
varying float vUp;
varying vec3 vSurfaceUp;
varying vec3 vWorldPos;

vec4 cell(float index, vec2 uv) {
  float c = mod(index, ${SMOKE_FRAMES}.0);
  return texture2D(tSheet, vec2((c + uv.x) / ${SMOKE_FRAMES}.0, uv.y));
}

void main() {
  float base = floor(vStage);
  vec4 texel = mix(cell(base, vUv), cell(base + 1.0, vUv), fract(vStage));
  if (texel.a < 0.02) discard;

  // Thinning with height is the whole read of a column: solid and black where
  // it is coming off the roof, and gone by the time it has climbed.
  float thin = 1.0 - smoothstep(0.68, 1.0, vUp);
  float a = texel.a * 0.66 * thin;
  if (a < 0.004) discard;

  float daylight = clamp(dot(normalize(vSurfaceUp), uSunDir) * 2.4 + 0.3, 0.0, 1.0);
  vec3 lit = texel.rgb * (uSunColor * uSunIntensity * 0.62 * daylight + uAmbientColor * 1.1);
  // Soot near the fire, ordinary grey smoke above it.
  lit *= mix(0.42, 1.0, vUp);

  gl_FragColor = vec4(lit * a, a);
}
`;

/** Instanced billboards with a bottom-anchored quad. */
function billboardGeometry(centred: boolean): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const low = centred ? -0.5 : 0;
  const high = centred ? 0.5 : 1;
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-0.5, low, 0, 0.5, low, 0, 0.5, high, 0, -0.5, high, 0],
      3,
    ),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  g.instanceCount = 0;
  return g;
}

export class SmokeLayer {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.ShaderMaterial;

  private capacity = 0;
  private count = 0;
  private origin!: THREE.InstancedBufferAttribute;
  private size!: THREE.InstancedBufferAttribute;
  private phase!: THREE.InstancedBufferAttribute;

  constructor(shared: SharedUniforms) {
    this.geometry = billboardGeometry(false);

    this.material = new THREE.ShaderMaterial({
      name: 'war-smoke',
      vertexShader: smokeVertex,
      fragmentShader: smokeFragment,
      uniforms: {
        tSheet: { value: spriteSheets().smoke },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uTime: shared.uTime,
        uFadeNear: { value: SMOKE_NEAR },
        uFadeFar: { value: SMOKE_FAR },
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'war-smoke';
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
    this.grow(64);
  }

  private grow(capacity: number): void {
    const previous = this.capacity > 0
      ? {
          origin: (this.origin.array as Float32Array).slice(0, this.count * 3),
          size: (this.size.array as Float32Array).slice(0, this.count),
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
    this.phase = make(1);
    this.geometry.setAttribute('iOrigin', this.origin);
    this.geometry.setAttribute('iSize', this.size);
    this.geometry.setAttribute('iPhase', this.phase);

    if (previous) {
      (this.origin.array as Float32Array).set(previous.origin);
      (this.size.array as Float32Array).set(previous.size);
      (this.phase.array as Float32Array).set(previous.phase);
    }
  }

  begin(): void {
    this.count = 0;
  }

  add(s: SmokePlacement): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    const o = this.origin.array as Float32Array;
    o[i * 3] = s.origin.x;
    o[i * 3 + 1] = s.origin.y;
    o[i * 3 + 2] = s.origin.z;
    (this.size.array as Float32Array)[i] = s.size;
    (this.phase.array as Float32Array)[i] = s.phase;
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count === 0) return;
    this.origin.needsUpdate = true;
    this.size.needsUpdate = true;
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

// --- Arrows, and the dust where they land -----------------------------------

/**
 * The flight, shared by both passes.
 *
 * One instance is a position that repeats: the arrow is in the air for the
 * first `FLIGHT` of the cycle and the dust plays out over the rest of it, so
 * the two meshes are the same instance buffer read at two different times.
 */
const FLIGHT = 0.55;

const shotCommon = /* glsl */ `
attribute vec3 iFrom;
attribute vec3 iTo;
attribute float iArc;
attribute float iRate;
attribute float iPhase;

uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;

const float FLIGHT = ${FLIGHT};

/** Where the arrow is at flight fraction t, and which way it is going. */
void trajectory(float t, out vec3 pos, out vec3 velocity) {
  // GLSL reserves the obvious name for this; it is the straight line under the arc.
  vec3 level = mix(iFrom, iTo, t);
  vec3 up = normalize(level);
  // A parabola, not a sine: it is what a thrown thing does, and the difference
  // is visible at the top of the arc where a sine flattens out.
  pos = level + up * (4.0 * t * (1.0 - t) * iArc);
  velocity = normalize((iTo - iFrom) + up * (4.0 * (1.0 - 2.0 * t) * iArc));
}
`;

const arrowVertex = /* glsl */ `
${shotCommon}

varying vec2 vUv;
varying float vAlive;

void main() {
  float cycle = fract(uTime * iRate + iPhase);
  float t = cycle / FLIGHT;
  vAlive = cycle < FLIGHT ? 1.0 : 0.0;

  vec3 pos;
  vec3 velocity;
  trajectory(clamp(t, 0.0, 1.0), pos, velocity);

  vec3 view = normalize(cameraPosition - pos);
  vec3 side = cross(velocity, view);
  if (dot(side, side) < 1e-6) side = vec3(0.0, 1.0, 0.0);
  side = normalize(side);

  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, length(cameraPosition - pos));
  vec2 quad = position.xy;
  // Stretched along the flight, which is both what an arrow looks like at speed
  // and what makes a two-metre object visible at all from forty metres.
  vec3 world = pos + velocity * (quad.x * 2.2 * grow) + side * (quad.y * 0.55 * grow);

  vUv = quad + 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const arrowFragment = /* glsl */ `
precision highp float;

uniform sampler2D tSheet;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;

varying vec2 vUv;
varying float vAlive;

void main() {
  if (vAlive < 0.5) discard;
  vec4 texel = texture2D(tSheet, vUv);
  if (texel.a < 0.35) discard;
  // Flat-lit: it is in the air, moving, and thirty pixels long at the closest
  // the camera ever gets to one.
  vec3 lit = texel.rgb * (uSunColor * uSunIntensity * 0.5 + uAmbientColor);
  gl_FragColor = vec4(lit, 1.0);
}
`;

const impactVertex = /* glsl */ `
${shotCommon}

varying vec2 vUv;
varying float vStage;
varying float vFade;
varying vec3 vSurfaceUp;

void main() {
  float cycle = fract(uTime * iRate + iPhase);
  // Runs from the moment the arrow lands to the end of the cycle.
  float age = clamp((cycle - FLIGHT) / (1.0 - FLIGHT), 0.0, 1.0);
  vStage = age * ${IMPACT_FRAMES}.0;
  vFade = cycle < FLIGHT ? 0.0 : 1.0 - smoothstep(0.55, 1.0, age);

  vec3 up = normalize(iTo);
  vec3 toCamera = cameraPosition - iTo;
  vec3 forward = normalize(toCamera);
  vec3 right = cross(up, forward);
  if (dot(right, right) < 1e-6) right = vec3(1.0, 0.0, 0.0);
  right = normalize(right);

  float grow = 1.0 - smoothstep(uFadeNear, uFadeFar, length(toCamera));
  // Dust expands as it dissipates; the sheet's own stages carry the rest.
  float size = (1.6 + age * 2.4) * grow;

  vec2 quad = position.xy;
  vec3 world = iTo + right * (quad.x * size) + up * ((quad.y + 0.5) * size);

  vUv = quad + 0.5;
  vSurfaceUp = up;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const impactFragment = /* glsl */ `
precision highp float;

uniform sampler2D tSheet;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;
uniform vec3 uDust;

varying vec2 vUv;
varying float vStage;
varying float vFade;
varying vec3 vSurfaceUp;

void main() {
  if (vFade <= 0.0) discard;
  float c = min(floor(vStage), ${IMPACT_FRAMES}.0 - 1.0);
  vec4 texel = texture2D(tSheet, vec2((c + vUv.x) / ${IMPACT_FRAMES}.0, vUv.y));
  float a = texel.a * vFade * 0.8;
  if (a < 0.01) discard;

  // The sheet is grey; the ground is not. Tinting it with the dust colour is
  // what makes a burst read as *this* ground being thrown up rather than as a
  // puff of studio smoke.
  float daylight = clamp(dot(normalize(vSurfaceUp), uSunDir) * 2.4 + 0.3, 0.0, 1.0);
  vec3 lit = texel.rgb * uDust * (uSunColor * uSunIntensity * 0.7 * daylight + uAmbientColor);
  gl_FragColor = vec4(lit * a, a);
}
`;

/**
 * Arrows and their impacts, off one instance buffer.
 *
 * The two meshes share a geometry, which is the whole trick: an instance is a
 * *shot*, and the arrow pass and the dust pass are that same shot sampled at
 * two different points in its cycle. Uploading it twice would have doubled the
 * buffers to say the same thing.
 */
export class SiegeLayer {
  readonly arrows: THREE.Mesh;
  readonly impacts: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private arrowMaterial: THREE.ShaderMaterial;
  private impactMaterial: THREE.ShaderMaterial;

  private capacity = 0;
  private count = 0;
  private from!: THREE.InstancedBufferAttribute;
  private to!: THREE.InstancedBufferAttribute;
  private arc!: THREE.InstancedBufferAttribute;
  private rate!: THREE.InstancedBufferAttribute;
  private phase!: THREE.InstancedBufferAttribute;

  constructor(shared: SharedUniforms) {
    this.geometry = billboardGeometry(true);
    const sheets = spriteSheets();

    this.arrowMaterial = new THREE.ShaderMaterial({
      name: 'war-arrows',
      vertexShader: arrowVertex,
      fragmentShader: arrowFragment,
      uniforms: {
        tSheet: { value: sheets.projectile },
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uTime: shared.uTime,
        uFadeNear: { value: SIEGE_NEAR },
        uFadeFar: { value: SIEGE_FAR },
      },
      side: THREE.DoubleSide,
    });

    this.impactMaterial = new THREE.ShaderMaterial({
      name: 'war-impacts',
      vertexShader: impactVertex,
      fragmentShader: impactFragment,
      uniforms: {
        tSheet: { value: sheets.impact },
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunIntensity: shared.uSunIntensity,
        uAmbientColor: shared.uAmbientColor,
        uDust: { value: new THREE.Color(0.52, 0.44, 0.35) },
        uTime: shared.uTime,
        uFadeNear: { value: SIEGE_NEAR },
        uFadeFar: { value: SIEGE_FAR },
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.arrows = new THREE.Mesh(this.geometry, this.arrowMaterial);
    this.arrows.frustumCulled = false;
    this.arrows.name = 'war-arrows';
    this.arrows.renderOrder = 5;
    this.arrows.visible = false;

    this.impacts = new THREE.Mesh(this.geometry, this.impactMaterial);
    this.impacts.frustumCulled = false;
    this.impacts.name = 'war-impacts';
    this.impacts.renderOrder = 7;
    this.impacts.visible = false;

    this.grow(128);
  }

  private grow(capacity: number): void {
    const previous = this.capacity > 0
      ? {
          from: (this.from.array as Float32Array).slice(0, this.count * 3),
          to: (this.to.array as Float32Array).slice(0, this.count * 3),
          arc: (this.arc.array as Float32Array).slice(0, this.count),
          rate: (this.rate.array as Float32Array).slice(0, this.count),
          phase: (this.phase.array as Float32Array).slice(0, this.count),
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
    this.arc = make(1);
    this.rate = make(1);
    this.phase = make(1);
    this.geometry.setAttribute('iFrom', this.from);
    this.geometry.setAttribute('iTo', this.to);
    this.geometry.setAttribute('iArc', this.arc);
    this.geometry.setAttribute('iRate', this.rate);
    this.geometry.setAttribute('iPhase', this.phase);

    if (previous) {
      (this.from.array as Float32Array).set(previous.from);
      (this.to.array as Float32Array).set(previous.to);
      (this.arc.array as Float32Array).set(previous.arc);
      (this.rate.array as Float32Array).set(previous.rate);
      (this.phase.array as Float32Array).set(previous.phase);
    }
  }

  begin(): void {
    this.count = 0;
  }

  add(s: ShotPlacement): void {
    if (this.count >= this.capacity) this.grow(this.capacity * 2);
    const i = this.count++;
    const f = this.from.array as Float32Array;
    f[i * 3] = s.from.x;
    f[i * 3 + 1] = s.from.y;
    f[i * 3 + 2] = s.from.z;
    const t = this.to.array as Float32Array;
    t[i * 3] = s.to.x;
    t[i * 3 + 1] = s.to.y;
    t[i * 3 + 2] = s.to.z;
    (this.arc.array as Float32Array)[i] = s.arc;
    (this.rate.array as Float32Array)[i] = s.rate;
    (this.phase.array as Float32Array)[i] = s.phase;
  }

  commit(): void {
    this.geometry.instanceCount = this.count;
    this.arrows.visible = this.count > 0;
    this.impacts.visible = this.count > 0;
    if (this.count === 0) return;
    this.from.needsUpdate = true;
    this.to.needsUpdate = true;
    this.arc.needsUpdate = true;
    this.rate.needsUpdate = true;
    this.phase.needsUpdate = true;
  }

  setRange(near: number, far: number): void {
    this.arrowMaterial.uniforms.uFadeNear.value = near;
    this.arrowMaterial.uniforms.uFadeFar.value = far;
    this.impactMaterial.uniforms.uFadeNear.value = near;
    this.impactMaterial.uniforms.uFadeFar.value = far;
  }

  get instanceCount(): number {
    return this.count;
  }

  dispose(): void {
    this.geometry.dispose();
    this.arrowMaterial.dispose();
    this.impactMaterial.dispose();
  }
}
